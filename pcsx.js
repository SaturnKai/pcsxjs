/**
 * PCSXJS — Modular PlayStation 1 emulator library
 *
 * Wraps the Emscripten-compiled PCSX emulator into a clean, framework-agnostic API.
 * No hardcoded DOM dependencies — provide your own canvas element and callbacks.
 *
 * The Emscripten runtime (pcsx_ww.js) is loaded inside a hidden iframe to provide
 * full global scope isolation. This allows the emulator to be destroyed and
 * re-created without "Identifier already declared" errors or leaked timers.
 *
 * Usage:
 *   const emu = new PCSXEmulator({
 *     canvas: document.getElementById('my-canvas'),
 *     workerUrl: '/path/to/pcsx_worker.js',   // optional
 *     wasmUrl: '/path/to/pcsx_ww.wasm',       // optional
 *     coreScriptUrl: '/path/to/pcsx_ww.js',   // optional
 *     onStatus: (text) => { },                // optional
 *     onLog: (text) => { },                   // optional
 *     onReady: () => { },                     // optional
 *     onError: (err) => { },                  // optional
 *   });
 *
 *   await emu.init();
 *   emu.loadISO(fileObject);
 *   emu.goFullscreen();
 *   emu.destroy();
 */

class PCSXEmulator {
  /**
   * @param {Object} options
   * @param {HTMLCanvasElement|string} options.canvas - Canvas element or CSS selector
   * @param {string} [options.workerUrl='pcsx_worker.js'] - URL to the pcsx_worker.js file
   * @param {string} [options.wasmUrl] - URL to the pcsx_ww.wasm file (auto-resolved if not set)
   * @param {string} [options.coreScriptUrl='pcsx_ww.js'] - URL to the pcsx_ww.js Emscripten glue
   * @param {HTMLElement} [options.keyboardListeningElement] - Element to listen for keyboard events on (default: document)
   * @param {function} [options.onStatus] - Called with status text updates
   * @param {function} [options.onLog] - Called with log/debug messages
   * @param {function} [options.onReady] - Called when the emulator is ready for ISO loading
   * @param {function} [options.onError] - Called on errors
   */
  constructor(options = {}) {
    // Resolve canvas
    if (typeof options.canvas === 'string') {
      this._canvas = document.querySelector(options.canvas);
    } else if (options.canvas instanceof HTMLCanvasElement) {
      this._canvas = options.canvas;
    } else {
      throw new Error('PCSXEmulator: "canvas" option must be an HTMLCanvasElement or a CSS selector string.');
    }

    if (!this._canvas) {
      throw new Error('PCSXEmulator: Could not find canvas element.');
    }

    // Configuration
    this._workerUrl = options.workerUrl || 'pcsx_worker.js';
    this._wasmUrl = options.wasmUrl || null;
    this._coreScriptUrl = options.coreScriptUrl || 'pcsx_ww.js';
    this._keyboardListeningElement = options.keyboardListeningElement || null;

    // Callbacks
    this._onStatus = options.onStatus || (() => {});
    this._onLog = options.onLog || ((text) => console.log('[PCSX]', text));
    this._onReady = options.onReady || (() => {});
    this._onError = options.onError || ((err) => console.error('[PCSX]', err));

    // Internal state
    this._iframe = null;
    this._iframeWindow = null;
    this._worker = null;
    this._initialized = false;
    this._destroyed = false;
    this._running = false;
    this._controllerInterval = null;
    this._padStatus1 = null;
    this._padStatus2 = null;
    this._vramPtr = null;
    this._statesArrs = [];
    this._imgData32 = null;
    this._soundFeedStreamData = null;
  }

  /**
   * Initialize the emulator. Loads the WASM module inside an iframe for isolation,
   * sets up globals, and prepares for ISO loading.
   * @returns {Promise<void>}
   */
  async init() {
    if (this._initialized) {
      throw new Error('PCSXEmulator: Already initialized. Call destroy() first.');
    }
    this._destroyed = false;

    const self = this;

    // Create a hidden iframe to isolate the Emscripten runtime.
    // This gives pcsx_ww.js its own global scope so that:
    //  1. All var/class/function declarations are scoped to the iframe
    //  2. All timers (setTimeout/setInterval) are scoped to the iframe
    //  3. Removing the iframe kills everything cleanly
    this._iframe = document.createElement('iframe');
    this._iframe.style.display = 'none';
    this._iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    document.body.appendChild(this._iframe);
    this._iframeWindow = this._iframe.contentWindow;

    const iWin = this._iframeWindow;

    // Install global functions into the iframe's window that the Emscripten
    // C code calls via EM_ASM (ASM_CONSTS). These must exist in the same
    // global scope as pcsx_ww.js.
    iWin.cout_print = (text) => {
      if (!self._destroyed) self._onLog(text);
    };

    iWin.my_SDL_LockSurface = (surf) => {
      if (self._destroyed) return 0;
      const SDL = iWin.SDL;
      if (!SDL) return 0;
      const surfData = SDL.surfaces[surf];
      surfData.locked++;
      if (surfData.locked > 1) return 0;

      if (!surfData.buffer) {
        surfData.buffer = iWin._malloc(surfData.width * surfData.height * 4);
        iWin.HEAP32[(((surf) + (20)) >> 2)] = surfData.buffer;
      }

      iWin.HEAP32[(((surf) + (20)) >> 2)] = surfData.buffer;
      if (!surfData.image) {
        surfData.image = surfData.ctx.getImageData(0, 0, surfData.width, surfData.height);
      }
      return 0;
    };

    iWin.my_SDL_UnlockSurface = (surf) => {
      if (self._destroyed) return;
      const SDL = iWin.SDL;
      if (!SDL) return;

      const surfData = SDL.surfaces[surf];
      if (!surfData.locked || --surfData.locked > 0) return;

      const data = surfData.image.data;
      const src = surfData.buffer >> 2;

      if (!self._imgData32) {
        self._imgData32 = new Uint32Array(data.buffer);
      }
      self._imgData32.set(iWin.HEAP32.subarray(src, src + self._imgData32.length));
      surfData.ctx.putImageData(surfData.image, 0, 0);
    };

    iWin.var_setup = () => {
      if (self._destroyed) return;
      const M = iWin.Module;
      self._soundFeedStreamData = M.cwrap('SoundFeedStreamData', 'null', ['number', 'number']);
      self._vramPtr = iWin._get_ptr(0);
      self._padStatus1 = iWin._get_ptr(1);
      self._padStatus2 = iWin._get_ptr(2);

      const SDL = iWin.SDL;
      if (SDL) {
        SDL.defaults.copyOnLock = false;
        SDL.defaults.opaqueFrontBuffer = false;
      }

      self._onLog('Starting worker');
      self._worker = new Worker(self._workerUrl);
      self._worker.onmessage = (event) => self._onWorkerMessage(event);

      // Make pcsx_worker accessible in the iframe scope for EM_ASM calls
      iWin.pcsx_worker = self._worker;

      self._onReady();
      setTimeout(() => {
        if (!self._destroyed) {
          self._onStatus('Ready — load an ISO file to begin.');
        }
      }, 2);
    };

    // Build the Module configuration object inside the iframe's scope
    const Module = {
      preRun: [],
      postRun: [],
      print: (text) => {
        if (!self._destroyed) self._onLog(text);
      },
      printErr: (text) => {
        if (!self._destroyed) self._onLog('[ERR] ' + text);
      },
      canvas: this._canvas,
      setStatus: (text) => {
        if (self._destroyed) return;
        self._onStatus(text);
        self._onLog('setStatus: ' + text);
      },
      totalDependencies: 0,
      monitorRunDependencies: function (left) {
        this.totalDependencies = Math.max(this.totalDependencies, left);
        const msg = left
          ? 'Preparing... (' + (this.totalDependencies - left) + '/' + this.totalDependencies + ')'
          : 'All downloads complete.';
        if (!self._destroyed) Module.setStatus(msg);
      },
    };

    // Keyboard events must be captured from the parent document (not the iframe's).
    // SDL_Init falls back to `document` which inside the iframe would be invisible.
    // Always point to a parent-document element.
    Module.keyboardListeningElement = this._keyboardListeningElement || document;
    if (this._keyboardListeningElement && !this._keyboardListeningElement.hasAttribute('tabindex')) {
      this._keyboardListeningElement.setAttribute('tabindex', '0');
    }

    // Configure WASM location if provided
    if (this._wasmUrl) {
      Module.locateFile = (path) => {
        if (path.endsWith('.wasm')) {
          return self._wasmUrl;
        }
        return path;
      };
    }

    // Install Module in the iframe's global scope
    iWin.Module = Module;

    // Set up webgl context lost handler on the real canvas
    this._webglLostHandler = (e) => {
      self._onError('WebGL context lost. You will need to reload the page.');
      e.preventDefault();
    };
    this._canvas.addEventListener('webglcontextlost', this._webglLostHandler, false);

    this._contextMenuHandler = (e) => e.preventDefault();
    this._canvas.addEventListener('contextmenu', this._contextMenuHandler);

    // Load pcsx_ww.js inside the iframe — all its globals (var SDL, class ExitStatus,
    // var Browser, etc.) are scoped to the iframe and will be fully garbage collected
    // when we remove the iframe on destroy().
    await this._loadScriptInIframe(this._coreScriptUrl);

    this._initialized = true;
  }

  /**
   * Load an ISO file and start emulation.
   * @param {File} file - A File object (from an <input type="file"> or drag-drop)
   */
  loadISO(file) {
    if (!this._initialized) {
      throw new Error('PCSXEmulator: Not initialized. Call init() first.');
    }
    if (!this._worker) {
      throw new Error('PCSXEmulator: Worker not ready yet. Wait for onReady callback.');
    }
    if (!file) {
      throw new Error('PCSXEmulator: No file provided.');
    }

    this._onLog('Loading ISO: ' + file.name);
    this._worker.postMessage({ cmd: 'loadfile', file: file });
    this._running = true;
    this._startControllerPolling();
  }

  /**
   * Load a ROM/ISO from a URL. Fetches the data on the main thread and sends it to the worker.
   * Works with blob: URLs, http: URLs, etc.
   * @param {string} url - URL to the ISO file (supports blob:, http:, etc.)
   * @param {string} [filename] - Optional filename (extracted from URL if not provided)
   */
  async loadISOFromUrl(url, filename) {
    if (!this._initialized) {
      throw new Error('PCSXEmulator: Not initialized. Call init() first.');
    }
    if (!this._worker) {
      throw new Error('PCSXEmulator: Worker not ready yet. Wait for onReady callback.');
    }

    if (!filename) {
      filename = url.split('/').pop().split('?')[0] || 'game.bin';
    }

    this._onStatus('Downloading ' + filename + '...');
    this._onLog('Fetching ISO from URL: ' + url);

    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const buffer = await response.arrayBuffer();
      this.loadISOFromBuffer(buffer, filename);
    } catch (err) {
      this._onError('Failed to fetch ISO: ' + err.message);
    }
  }

  /**
   * Load a ROM/ISO from raw binary data (ArrayBuffer, Uint8Array, or Blob).
   * Ideal for loading disc images from IndexedDB, in-memory buffers, etc.
   * @param {ArrayBuffer|Uint8Array|Blob} data - The disc image binary data
   * @param {string} [filename='game.bin'] - Filename to use in the emulator's virtual filesystem
   */
  async loadISOFromBuffer(data, filename = 'game.bin') {
    if (!this._initialized) {
      throw new Error('PCSXEmulator: Not initialized. Call init() first.');
    }
    if (!this._worker) {
      throw new Error('PCSXEmulator: Worker not ready yet. Wait for onReady callback.');
    }

    // Convert Blob to ArrayBuffer if needed
    if (data instanceof Blob) {
      data = await data.arrayBuffer();
    }

    // Ensure we have a Uint8Array
    let bytes;
    if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data);
    } else if (data instanceof Uint8Array) {
      bytes = data;
    } else {
      throw new Error('PCSXEmulator: data must be an ArrayBuffer, Uint8Array, or Blob.');
    }

    this._onLog('Loading ISO from buffer: ' + filename + ' (' + bytes.length + ' bytes)');
    this._onStatus('Loading ' + filename + '...');

    // Send to worker — transfer the buffer for zero-copy performance
    this._worker.postMessage(
      { cmd: 'loadbuffer', name: filename, data: bytes },
      [bytes.buffer]
    );
    this._running = true;
    this._startControllerPolling();
  }

  /**
   * Check if the emulator is currently running.
   * @returns {boolean}
   */
  get isRunning() {
    return this._running;
  }

  /**
   * Check if the emulator is initialized.
   * @returns {boolean}
   */
  get isInitialized() {
    return this._initialized;
  }

  /**
   * Toggle fullscreen on the canvas container.
   */
  goFullscreen() {
    if (!this._initialized || !this._iframeWindow) return;

    const canvas = this._canvas;
    const Browser = this._iframeWindow.Browser;

    if (Browser && Browser.isFullscreen) {
      if (canvas.exitFullscreen) canvas.exitFullscreen();
      return;
    }

    if (Browser) {
      Browser.lockPointer = false;
      Browser.resizeCanvas = false;
      Browser.vrDevice = null;
    }

    const canvasContainer = canvas.parentNode;
    const self = this;

    function fullscreenChange() {
      if (Browser) Browser.isFullscreen = false;

      const fse = document.fullscreenElement ||
        document.mozFullScreenElement ||
        document.msFullscreenElement ||
        document.webkitFullscreenElement ||
        document.webkitCurrentFullScreenElement;

      if (fse === canvasContainer) {
        canvas.exitFullscreen = document.exitFullscreen ||
          document.cancelFullScreen ||
          document.mozCancelFullScreen ||
          document.msExitFullscreen ||
          document.webkitCancelFullScreen ||
          function () {};
        canvas.exitFullscreen = canvas.exitFullscreen.bind(document);
        if (Browser) {
          Browser.isFullscreen = true;
          Browser.updateCanvasDimensions(canvas);
        }
      } else {
        if (Browser) {
          Browser.updateCanvasDimensions(canvas);
        }
      }
    }

    if (!this._fullscreenHandlersInstalled) {
      this._fullscreenHandlersInstalled = true;
      this._fullscreenHandler = fullscreenChange;
      document.addEventListener('fullscreenchange', fullscreenChange, false);
      document.addEventListener('webkitfullscreenchange', fullscreenChange, false);
    }

    const requestFS = canvasContainer.requestFullscreen ||
      canvasContainer.webkitRequestFullscreen ||
      canvasContainer.msRequestFullscreen;

    if (requestFS) {
      requestFS.call(canvasContainer);
    }
  }

  /**
   * Fully destroy the emulator and release all resources.
   * Terminates the web worker, removes the iframe (killing all Emscripten globals,
   * timers, and WASM memory), and removes event listeners.
   * After calling destroy(), you can safely call init() again on a new instance.
   */
  destroy() {
    this._destroyed = true;
    this._initialized = false;
    this._running = false;

    // 1. Stop controller polling immediately
    if (this._controllerInterval) {
      clearInterval(this._controllerInterval);
      this._controllerInterval = null;
    }

    // 2. Terminate the web worker
    if (this._worker) {
      this._worker.terminate();
      this._worker = null;
    }

    // 3. Close SDL audio (stop audio timers) before removing the iframe
    if (this._iframeWindow) {
      try {
        const SDL = this._iframeWindow.SDL;
        if (SDL && SDL.audio) {
          // Clear the audio timer to prevent it from firing after destroy
          if (SDL.audio.timer !== undefined) {
            this._iframeWindow.clearTimeout(SDL.audio.timer);
            SDL.audio.timer = undefined;
          }
          SDL.audio.paused = true;
          SDL.audio = null;
        }
        // Null out the pcsx_worker reference so any straggling EM_ASM calls
        // hit null instead of throwing ReferenceError
        this._iframeWindow.pcsx_worker = null;
      } catch (e) {
        // iframe may already be detached
      }
    }

    // 4. Remove the iframe — this is the nuclear cleanup option.
    //    Removing the iframe destroys its entire JS context:
    //    - All var/class/function declarations (SDL, Browser, ExitStatus, etc.)
    //    - All pending setTimeout/setInterval timers
    //    - All WASM memory
    //    - All event listeners registered within the iframe
    if (this._iframe && this._iframe.parentNode) {
      this._iframe.parentNode.removeChild(this._iframe);
    }
    this._iframe = null;
    this._iframeWindow = null;

    // 5. Remove canvas event listeners
    if (this._canvas) {
      if (this._webglLostHandler) {
        this._canvas.removeEventListener('webglcontextlost', this._webglLostHandler, false);
        this._webglLostHandler = null;
      }
      if (this._contextMenuHandler) {
        this._canvas.removeEventListener('contextmenu', this._contextMenuHandler);
        this._contextMenuHandler = null;
      }
    }

    // 6. Remove fullscreen event listeners
    if (this._fullscreenHandlersInstalled && this._fullscreenHandler) {
      document.removeEventListener('fullscreenchange', this._fullscreenHandler, false);
      document.removeEventListener('webkitfullscreenchange', this._fullscreenHandler, false);
      this._fullscreenHandlersInstalled = false;
      this._fullscreenHandler = null;
    }

    // 7. Clear internal references
    this._statesArrs = [];
    this._imgData32 = null;
    this._soundFeedStreamData = null;
    this._padStatus1 = null;
    this._padStatus2 = null;
    this._vramPtr = null;
  }

  // --- Internal methods ---

  /**
   * Handle messages from the emulation worker.
   */
  _onWorkerMessage(event) {
    if (this._destroyed) return;

    const data = event.data;
    const M = this._iframeWindow ? this._iframeWindow.Module : null;
    if (!M) return;

    switch (data.cmd) {
      case 'print':
        this._onLog('> ' + data.txt);
        break;

      case 'setStatus':
        this._onStatus(data.txt);
        break;

      case 'setUI':
        // Silently ignore DOM manipulation commands from the worker
        break;

      case 'render': {
        if (!this._worker || !M.HEAPU8) break;
        const vramArr = data.vram;
        M.HEAPU8.set(vramArr, this._vramPtr);
        this._worker.postMessage({ cmd: 'return_vram', vram: vramArr }, [vramArr.buffer]);
        this._iframeWindow._render(data.x, data.y, data.sx, data.sy, data.dx, data.dy, data.rgb24);
        break;
      }

      case 'return_states':
        this._statesArrs.push(data.states);
        break;

      case 'SoundFeedStreamData': {
        if (!M._malloc) break;
        const pSoundArr = data.pSound;
        const pSoundPtr = M._malloc(pSoundArr.length);
        M.HEAPU8.set(pSoundArr, pSoundPtr);
        this._soundFeedStreamData(pSoundPtr, data.lBytes);
        M._free(pSoundPtr);
        break;
      }

      default:
        this._onLog('Unknown worker cmd: ' + data.cmd);
    }
  }

  /**
   * Start polling controllers and keyboard, sending state to the worker.
   */
  _startControllerPolling() {
    if (this._controllerInterval) return;

    const self = this;
    const poll = () => {
      if (self._destroyed || !self._worker || !self._padStatus1 || !self._iframeWindow) return;

      const M = self._iframeWindow.Module;
      if (!M || !M.HEAPU8) return;

      self._iframeWindow._CheckJoy();
      self._iframeWindow._CheckKeyboard();

      const statesSrc = M.HEAPU8.subarray(self._padStatus1, self._padStatus1 + 48);
      let statesArr;

      // Pool recycling
      while (self._statesArrs.length > 50) {
        self._statesArrs.pop();
      }

      if (self._statesArrs.length > 0) {
        statesArr = self._statesArrs.pop();
        statesArr.set(statesSrc);
      } else {
        statesArr = new Uint8Array(statesSrc);
      }

      self._worker.postMessage({ cmd: 'padStatus', states: statesArr }, [statesArr.buffer]);
    };

    this._controllerInterval = setInterval(poll, 10);
  }

  /**
   * Load a script inside the iframe's document.
   * @param {string} url
   * @returns {Promise<void>}
   */
  _loadScriptInIframe(url) {
    return new Promise((resolve, reject) => {
      if (!this._iframe || !this._iframeWindow) {
        return reject(new Error('PCSXEmulator: iframe not available'));
      }
      const iDoc = this._iframe.contentDocument || this._iframeWindow.document;
      const script = iDoc.createElement('script');
      script.type = 'text/javascript';
      // Resolve relative URLs against the parent page
      script.src = new URL(url, window.location.href).href;
      script.onload = resolve;
      script.onerror = () => reject(new Error(`Failed to load script: ${url}`));
      iDoc.head.appendChild(script);
    });
  }
}

// Export for ES modules, CommonJS, and global scope
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PCSXEmulator };
} else if (typeof window !== 'undefined') {
  window.PCSXEmulator = PCSXEmulator;
}
