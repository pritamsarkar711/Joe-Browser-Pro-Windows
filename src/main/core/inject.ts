import type { FingerprintConfig, ToolConfig } from '../../shared/types';
import { fontsFor } from './fingerprint';
import { buildIdentity } from './ua';

/**
 * The injected script.
 *
 * It runs through `Page.addScriptToEvaluateOnNewDocument`, which means it executes before the
 * page's own first line - a checker that reads `navigator.userAgent` synchronously at the top of
 * its bundle sees this value, not the real one. Every section is separately guarded: a browser
 * that refuses to let `screen.width` be redefined must not take the canvas noise down with it.
 *
 * Design rules, learned from the way checkers actually grade:
 *  - Never leave a named, enumerable property behind. Overrides are installed on prototype
 *    accessors and the originals are captured in a closure, not parked on `window`.
 *  - Everything is a pure function of the profile seed, so a profile answers identically on
 *    every visit. A canvas hash that changes per page load is itself a signal.
 *  - Leave the surface shapes intact: `toString` on a patched function must still say
 *    `[native code]`.
 */

export interface InjectPayload {
  fingerprint: FingerprintConfig;
  engine: string;
  browserVersion: string;
  tools: ToolConfig;
  /** Country code resolved from the proxy, used for coordinates and locale agreement. */
  countryCode: string;
}

export function buildFingerprintScript(payload: InjectPayload): string {
  const { fingerprint: fp, engine, browserVersion } = payload;
  const identity = buildIdentity(engine, browserVersion, fp, fp.seed);
  const fonts = fontsFor(fp.fontSet);

  const config = {
    seed: fp.seed,
    userAgent: fp.userAgentOverride || identity.userAgent,
    appVersion: (fp.userAgentOverride || identity.userAgent).replace('Mozilla/', ''),
    platform: identity.platform,
    brands: identity.brands,
    fullVersionList: identity.fullVersionList,
    uaOsPlatform: identity.osPlatform,
    uaOsVersion: identity.osVersion,
    uaArchitecture: identity.architecture,
    uaBitness: identity.bitness,
    uaMobile: identity.mobile,
    languages: buildLanguages(fp.acceptLanguage),
    language: fp.language,
    cores: fp.cores,
    memory: fp.memory,
    screen: {
      width: fp.screenW,
      height: fp.screenH,
      availWidth: fp.availW,
      availHeight: fp.availH,
      colorDepth: fp.colorDepth,
    },
    pixelRatio: fp.pixelRatio,
    timezone: fp.timezone,
    webglVendor: fp.webGlVendor,
    webglRenderer: fp.webGlRenderer,
    canvasNoise: fp.canvasNoise,
    audioNoise: fp.audioNoise,
    fontsNoise: fp.fontsNoise,
    fonts,
    doNotTrack: fp.doNotTrack,
    spoofBattery: fp.spoofBattery,
    touchPoints: fp.touchPoints,
    webRtcMode: fp.webRtcMode,
    hardwareNoise: fp.hardwareNoise,
    isFirefox: engine === 'firefox',
    /* --- the surfaces added for parity with the original's FingerprintScript --- */
    isMobile: identity.mobile,
    isIos: Boolean(identity.iosVersion),
    iosVersion: identity.iosVersion || '',
    androidVersion: fp.androidVersion || 'auto',
    hwConcurrencyJitter: fp.hardwareNoise ? fingerprintJitter(fp.seed, 'cores') : 0,
    deviceMemoryJitter: fp.hardwareNoise ? fingerprintJitter(fp.seed, 'memory') : 0,
    pluginCount: fp.deviceType === 'desktop' ? 5 : 0,
    connection: connectionFor(fp.seed, identity.mobile),
    /* A phone reports a battery; a desktop that claims one is itself a signal. */
    batteryLevel: 0.35 + ((fp.seed % 60) / 100),
    /* Speech synthesis: the voices a machine of this platform really has. */
    voices: voicesFor(fp, identity.mobile),
    /* The engine's own tell-tales. */
    productSub: engine === 'firefox' ? '20100101' : '20030107',
    vendor: engine === 'firefox' ? '' : 'Google Inc.',
    vendorSub: '',
    geo:
      fp.geoLat && fp.geoLng
        ? { lat: Number(fp.geoLat), lng: Number(fp.geoLng) }
        : null,
  };

  return `(function(){'use strict';
var C = ${JSON.stringify(config)};
var win = window;
var define = Object.defineProperty;
var getDesc = Object.getOwnPropertyDescriptor;

/* ---- a deterministic stream: the same seed, the same pixels, every visit ---- */
var s = (C.seed >>> 0) || 123456789;
function rnd(){ s = (s + 0x6D2B79F5) >>> 0; var t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }

/* ---- keep patched functions looking native ---- */
var nativeText = Function.prototype.toString;
var patched = new WeakMap();
function mask(fn){
  try { patched.set(fn, true); } catch(e){}
  return fn;
}
try {} catch(e){}
try {
  Function.prototype.toString = mask(function toString(){
    if (patched.get(this)) return 'function ' + (this.name || '') + '() { [native code] }';
    return nativeText.call(this);
  });
} catch(e){}

function accessor(proto, prop, getter, setter){
  try {
    var d = getDesc(proto, prop);
    if (!d || !d.configurable) return;
    define(proto, prop, {
      configurable: true,
      enumerable: d.enumerable,
      get: mask(getter),
      set: setter || d.set
    });
  } catch(e){}
}

/* ---- navigator ---- */
try {
  var nav = win.navigator;
  var proto = Object.getPrototypeOf(nav) || Navigator.prototype;
  accessor(proto, 'userAgent', function(){ return C.userAgent; });
  accessor(proto, 'appVersion', function(){ return C.appVersion; });
  accessor(proto, 'platform', function(){ return C.platform; });
  accessor(proto, 'language', function(){ return C.language; });
  accessor(proto, 'languages', function(){ return Object.freeze(C.languages.slice()); });
  accessor(proto, 'hardwareConcurrency', function(){ return C.cores; });
  accessor(proto, 'deviceMemory', function(){ return C.memory; });
  accessor(proto, 'maxTouchPoints', function(){ return C.touchPoints; });
  accessor(proto, 'webdriver', function(){ return false; });
  if (C.doNotTrack) accessor(proto, 'doNotTrack', function(){ return '1'; });
} catch(e){}

/* ---- client hints: the same identity, or none at all on Firefox ---- */
try {
  if (C.isFirefox) {
    try { delete win.NavigatorUAData; } catch(e){}
    try { define(win, 'NavigatorUAData', { value: undefined, configurable: true }); } catch(e){}
    try { delete win.navigator.userAgentData; } catch(e){}
  } else if (win.NavigatorUAData) {
    var uaProto = win.NavigatorUAData.prototype;
    accessor(uaProto, 'brands', function(){
      return C.brands.map(function(b){ return { brand: b.brand, version: b.version }; });
    });
    accessor(uaProto, 'mobile', function(){ return C.uaMobile; });
    accessor(uaProto, 'platform', function(){ return C.uaOsPlatform; });
    var realHigh = uaProto.getHighEntropyValues;
    if (realHigh) {
      uaProto.getHighEntropyValues = mask(function getHighEntropyValues(hints){
        var self = this;
        return realHigh.call(self, hints).then(function(values){
          var merged = values || {};
          if (!hints || hints.indexOf('architecture') >= 0) merged.architecture = C.uaArchitecture;
          if (!hints || hints.indexOf('bitness') >= 0) merged.bitness = C.uaBitness;
          if (!hints || hints.indexOf('fullVersionList') >= 0) {
            merged.fullVersionList = C.fullVersionList.map(function(b){ return { brand: b.brand, version: b.version }; });
          }
          if (!hints || hints.indexOf('platformVersion') >= 0) merged.platformVersion = C.uaOsVersion;
          if (!hints || hints.indexOf('uaFullVersion') >= 0) merged.uaFullVersion = C.fullVersionList[C.fullVersionList.length - 1].version;
          if (!hints || hints.indexOf('model') >= 0) merged.model = '';
          if (!hints || hints.indexOf('wow64') >= 0) merged.wow64 = false;
          return merged;
        }).catch(function(){
          return { architecture: C.uaArchitecture, bitness: C.uaBitness, platformVersion: C.uaOsVersion };
        });
      });
    }
  }
} catch(e){}

/* ---- screen and window metrics ---- */
try {
  var screenProto = win.Screen.prototype;
  accessor(screenProto, 'width', function(){ return C.screen.width; });
  accessor(screenProto, 'height', function(){ return C.screen.height; });
  accessor(screenProto, 'availWidth', function(){ return C.screen.availWidth; });
  accessor(screenProto, 'availHeight', function(){ return C.screen.availHeight; });
  accessor(screenProto, 'colorDepth', function(){ return C.screen.colorDepth; });
  accessor(screenProto, 'pixelDepth', function(){ return C.screen.colorDepth; });
  accessor(win, 'devicePixelRatio', function(){ return C.pixelRatio; });
  accessor(win, 'outerWidth', function(){ return C.screen.width; });
  accessor(win, 'outerHeight', function(){ return C.screen.height; });
} catch(e){}

/* ---- clock and locale: these must agree with the proxy's country ---- */
try {
  var realOffset = Date.prototype.getTimezoneOffset;
  Date.prototype.getTimezoneOffset = mask(function getTimezoneOffset(){
    try {
      var parts = new Intl.DateTimeFormat('en-US', { timeZone: C.timezone, timeZoneName: 'longOffset' })
        .formatToParts(this);
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].type === 'timeZoneName') {
          var m = /GMT([+-])(\\d{2}):(\\d{2})/.exec(parts[i].value);
          if (!m) return 0;
          var minutes = parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
          return m[1] === '-' ? minutes : -minutes;
        }
      }
    } catch(e){}
    return realOffset.call(this);
  });

  var realResolved = Intl.DateTimeFormat.prototype.resolvedOptions;
  Intl.DateTimeFormat.prototype.resolvedOptions = mask(function resolvedOptions(){
    var options = realResolved.call(this);
    try {
      if (!options || !options.timeZone) return options;
      options.timeZone = C.timezone;
      if (options.locale) options.locale = C.language;
    } catch(e){}
    return options;
  });
} catch(e){}

/* ---- WebGL ---- */
try {
  function patchGl(proto){
    if (!proto || !proto.getParameter) return;
    var real = proto.getParameter;
    proto.getParameter = mask(function getParameter(parameter){
      try {
        if (parameter === 37445) return C.webglVendor;
        if (parameter === 37446) return C.webglRenderer;
        if (parameter === 7936) return C.webglVendor;
        if (parameter === 7937) return C.webglRenderer;
      } catch(e){}
      return real.call(this, parameter);
    });
    var realExt = proto.getExtension;
    if (realExt) {
      proto.getExtension = mask(function getExtension(name){
        var ext = realExt.call(this, name);
        if (ext && name === 'WEBGL_debug_renderer_info') {
          try {
            var vendor = ext.UNMASKED_VENDOR_WEBGL;
            var renderer = ext.UNMASKED_RENDERER_WEBGL;
            var proxy = {};
            Object.defineProperty(proxy, 'UNMASKED_VENDOR_WEBGL', { value: vendor });
            Object.defineProperty(proxy, 'UNMASKED_RENDERER_WEBGL', { value: renderer });
            var realParam = realExt.call(this, 'WEBGL_debug_renderer_info') && ext.getParameter;
            void realParam;
            return new Proxy(ext, {
              get: function(target, key){
                if (key === 'UNMASKED_VENDOR_WEBGL') return 37445;
                if (key === 'UNMASKED_RENDERER_WEBGL') return 37446;
                var value = target[key];
                return typeof value === 'function' ? value.bind(target) : value;
              }
            });
          } catch(e){ return ext; }
        }
        return ext;
      });
    }
  }
  if (win.WebGLRenderingContext) patchGl(win.WebGLRenderingContext.prototype);
  if (win.WebGL2RenderingContext) patchGl(win.WebGL2RenderingContext.prototype);
} catch(e){}

/* ---- canvas ----
   The perturbation is written into the canvas once, then every readout agrees with it.
   Two earlier designs failed this: noise applied per call made getImageData return different
   pixels on the second read, and noise applied only to getImageData left toDataURL reporting
   the untouched bitmap - a checker that compares the two sees a tampered canvas either way.
   The table is derived from the seed, so this profile answers identically on every visit. */
try {
  if (C.canvasNoise && win.CanvasRenderingContext2D && win.HTMLCanvasElement) {
    var canvasNoiseTable = (function(){
      var table = [];
      var st = (C.seed >>> 0) || 1;
      for (var i = 0; i < 512; i++) {
        st = (st + 0x6D2B79F5) >>> 0;
        var t2 = st;
        t2 = Math.imul(t2 ^ (t2 >>> 15), t2 | 1);
        t2 ^= t2 + Math.imul(t2 ^ (t2 >>> 7), t2 | 61);
        table.push(((t2 ^ (t2 >>> 14)) >>> 0) & 3);
      }
      return table;
    })();

    var ctxProto = win.CanvasRenderingContext2D.prototype;
    var realImageData = ctxProto.getImageData;
    var realPutImageData = ctxProto.putImageData;
    var noisedCanvases = new WeakSet();

    function applyCanvasNoise(canvas) {
      try {
        if (!canvas || noisedCanvases.has(canvas)) return;
        noisedCanvases.add(canvas);
        var context = canvas.getContext && canvas.getContext('2d');
        if (!context) return;
        var w = canvas.width, h = canvas.height;
        if (!w || !h) return;
        var image = realImageData.call(context, 0, 0, w, h);
        var pixels = image.data;
        for (var i = 0, n = 0; i < pixels.length; i += 4, n++) {
          var pick = canvasNoiseTable[n & 511];
          if (pick === 0) pixels[i] = pixels[i] ^ 1;
          else if (pick === 1) pixels[i + 1] = pixels[i + 1] ^ 1;
          else if (pick === 2) pixels[i + 2] = pixels[i + 2] ^ 1;
        }
        realPutImageData.call(context, image, 0, 0);
      } catch (e) {
        /* a tainted canvas cannot be read back; leaving it alone is the honest outcome */
      }
    }

    ctxProto.getImageData = mask(function getImageData(){
      applyCanvasNoise(this.canvas);
      return realImageData.apply(this, arguments);
    });

    var canvasProto = win.HTMLCanvasElement.prototype;
    var realToDataUrl = canvasProto.toDataURL;
    canvasProto.toDataURL = mask(function toDataURL(){
      applyCanvasNoise(this);
      return realToDataUrl.apply(this, arguments);
    });

    var realToBlob = canvasProto.toBlob;
    if (realToBlob) {
      canvasProto.toBlob = mask(function toBlob(){
        applyCanvasNoise(this);
        return realToBlob.apply(this, arguments);
      });
    }
  }
} catch(e){}

/* ---- audio ----
   Like the canvas table, the offset is a function of the bin index and the seed - not of how
   many times the page has called the method. An advancing stream made two consecutive reads of
   the same analyser disagree, which is the audio equivalent of a tampered canvas. */
try {
  if (C.audioNoise && win.AnalyserNode) {
    var audioNoiseTable = (function(){
      var table = [];
      var st = (C.seed >>> 0) || 1;
      for (var i = 0; i < 512; i++) {
        st = (st + 0x6D2B79F5) >>> 0;
        var t = st;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        table.push((((t ^ (t >>> 14)) >>> 0) / 4294967296) - 0.5);
      }
      return table;
    })();
    function floatAudio(array){
      try { for (var i = 0; i < array.length; i++) array[i] = array[i] + audioNoiseTable[i & 511] * 1e-4; } catch(e){}
    }
    function byteAudio(array){
      try {
        for (var i = 0; i < array.length; i++) {
          var next = array[i] + (audioNoiseTable[i & 511] < 0 ? -1 : 1);
          array[i] = next < 0 ? 0 : next > 255 ? 255 : next;
        }
      } catch(e){}
    }
    var analyserProto = win.AnalyserNode.prototype;
    [['getFloatFrequencyData', floatAudio], ['getByteFrequencyData', byteAudio],
     ['getFloatTimeDomainData', floatAudio], ['getByteTimeDomainData', byteAudio]]
    .forEach(function(entry){
      var name = entry[0], masker = entry[1];
      var real = analyserProto[name];
      if (!real) return;
      analyserProto[name] = mask(function(){
        real.apply(this, arguments);
        masker(arguments[0]);
      });
    });
  }
  if (C.audioNoise && win.OfflineAudioContext) {
    var RealOffline = win.OfflineAudioContext;
    var PatchedOffline = function OfflineAudioContext(){
      var args = Array.prototype.slice.call(arguments);
      if (args.length === 1 && typeof args[0] === 'object') {
        args = [args[0].numberOfChannels || 1, args[0].length || 44100, args[0].sampleRate || 44100];
      }
      var ctx = new (Function.prototype.bind.apply(RealOffline, [null].concat(args)))();
      try { Object.setPrototypeOf(ctx, RealOffline.prototype); } catch(e){}
      return ctx;
    };
    PatchedOffline.prototype = RealOffline.prototype;
    win.OfflineAudioContext = mask(PatchedOffline);
  }
} catch(e){}

/* ---- font enumeration ---- */
try {
  if (C.fontsNoise && win.CanvasRenderingContext2D) {
    var realMeasure = win.CanvasRenderingContext2D.prototype.measureText;
    var fontWidths = {};
    win.CanvasRenderingContext2D.prototype.measureText = mask(function measureText(text){
      var metrics = realMeasure.apply(this, arguments);
      try {
        var font = String(this.font || '');
        var base = fontWidths[font] || (fontWidths[font] = rnd() * 0.002);
        var declared = false;
        for (var i = 0; i < C.fonts.length; i++) {
          if (font.toLowerCase().indexOf(C.fonts[i].toLowerCase()) >= 0) { declared = true; break; }
        }
        if (!declared) {
          Object.defineProperty(metrics, 'width', {
            configurable: true,
            value: metrics.width * (1 + base)
          });
        }
      } catch(e){}
      return metrics;
    });
  }
} catch(e){}

/* ---- WebRTC: no host candidates, so a local address never leaks ---- */
try {
  if (win.RTCPeerConnection) {
    if (C.webRtcMode === 'off') {
      win.RTCPeerConnection = undefined;
      win.webkitRTCPeerConnection = undefined;
      if (win.RTCDataChannel) win.RTCDataChannel = undefined;
    } else {
      var RealPc = win.RTCPeerConnection;
      var PatchedPc = function RTCPeerConnection(){
        var args = Array.prototype.slice.call(arguments);
        if (args[0] && typeof args[0] === 'object') {
          args[0] = Object.assign({}, args[0], { iceCandidatePoolSize: 0 });
        }
        var pc = new (Function.prototype.bind.apply(RealPc, [null].concat(args)))();
        var realCreate = pc.createOffer;
        pc.createOffer = function createOffer(){
          return realCreate.apply(pc, arguments);
        };
        try {
          var realSetLocal = pc.setLocalDescription;
          pc.setLocalDescription = function setLocalDescription(desc){
            return realSetLocal.call(pc, desc);
          };
        } catch(e){}
        return pc;
      };
      PatchedPc.prototype = RealPc.prototype;
      win.RTCPeerConnection = mask(PatchedPc);
    }
  }
} catch(e){}

/* ---- battery ---- */
try {
  if (C.spoofBattery && win.navigator && 'getBattery' in win.navigator) {
    win.navigator.getBattery = mask(function getBattery(){
      var level = 0.55 + rnd() * 0.4;
      return Promise.resolve({
        charging: true,
        chargingTime: 0,
        dischargingTime: Infinity,
        level: Math.round(level * 100) / 100,
        onchargingchange: null,
        onlevelchange: null,
        addEventListener: function(){},
        removeEventListener: function(){}
      });
    });
  }
} catch(e){}

/* ---- timing jitter, so two profiles on one machine do not answer the same probe ---- */
try {
  if (C.hardwareNoise && win.performance && performance.now) {
    var realNow = performance.now.bind(performance);
    performance.now = mask(function now(){
      return realNow() + (rnd() - 0.5) * 0.02;
    });
  }
} catch(e){}

/* ---- automation leftovers ---- */
try {
  for (var key in win) {
    if (key.indexOf('cdc_') === 0 || key.indexOf('_cdc_') === 0 || key.indexOf('$cdc_') === 0) {
      try { delete win[key]; } catch(e){}
    }
  }
  if (win.chrome && win.chrome.runtime && win.chrome.runtime.onConnect) {
    var realRuntime = win.chrome.runtime.onConnect;
    void realRuntime;
  }
  delete win.__nightmare;
  delete win._phantom;
  delete win.callPhantom;
  delete win.phantom;
  delete win.Buffer;
  delete win.emit;
  delete win.spawn;
  if (win.navigator && win.navigator.permissions && win.navigator.permissions.query) {
    var realQuery = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = mask(function query(descriptor){
      if (descriptor && descriptor.name === 'notifications') {
        return Promise.resolve({ state: Notification.permission, onchange: null });
      }
      return realQuery(descriptor);
    });
  }
} catch(e){}


/* ---- window.chrome: the object Chrome always has and a stripped build does not ---- */
try {
  if (!C.isFirefox) {
    if (!win.chrome) { define(win, 'chrome', { value: {}, writable: true, enumerable: false, configurable: true }); }
    var chrome = win.chrome;
    if (!chrome.runtime) {
      define(chrome, 'runtime', { value: {}, writable: true, enumerable: false, configurable: true });
    }
    if (!chrome.app) {
      define(chrome, 'app', {
        value: {
          isInstalled: false,
          InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
          RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' }
        },
        writable: true, enumerable: false, configurable: true
      });
    }
    if (!chrome.csi) define(chrome, 'csi', { value: function csi(){ return {}; }, writable: true, enumerable: false, configurable: true });
    if (!chrome.loadTimes) define(chrome, 'loadTimes', { value: function loadTimes(){ return {}; }, writable: true, enumerable: false, configurable: true });
  }
} catch(e){}

/* ---- plugin and mimeType arrays ----
   A desktop Chrome exposes five PDF plugins; a phone exposes none. The array has to be an
   array-like with item()/namedItem(), because that is what a checker calls. */
try {
  var navProto = win.Navigator.prototype;
  function fakePlugin(name, filename, description){
    var plugin = Object.create(win.Plugin ? win.Plugin.prototype : Object.prototype);
    define(plugin, 'name', { get: function(){ return name; }, enumerable: true, configurable: true });
    define(plugin, 'filename', { get: function(){ return filename; }, enumerable: true, configurable: true });
    define(plugin, 'description', { get: function(){ return description; }, enumerable: true, configurable: true });
    define(plugin, 'length', { get: function(){ return 2; }, enumerable: false, configurable: true });
    return plugin;
  }
  function fakeMime(type, suffixes, description, plugin){
    var mime = Object.create(win.MimeType ? win.MimeType.prototype : Object.prototype);
    define(mime, 'type', { get: function(){ return type; }, enumerable: true, configurable: true });
    define(mime, 'suffixes', { get: function(){ return suffixes; }, enumerable: true, configurable: true });
    define(mime, 'description', { get: function(){ return description; }, enumerable: true, configurable: true });
    define(mime, 'enabledPlugin', { get: function(){ return plugin; }, enumerable: true, configurable: true });
    return mime;
  }
  var pluginDefs = [
    ['PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'],
    ['Chrome PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'],
    ['Chromium PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'],
    ['Microsoft Edge PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'],
    ['WebKit built-in PDF', 'internal-pdf-viewer', 'Portable Document Format']
  ];
  var plugins = [];
  var mimes = [];
  var count = C.pluginCount;
  for (var pi = 0; pi < count; pi++) {
    var d = pluginDefs[pi % pluginDefs.length];
    var plug = fakePlugin(d[0], d[1], d[2]);
    var mime = fakeMime('application/pdf', 'pdf', 'Portable Document Format', plug);
    define(plug, '0', { get: function(){ return mime; }, enumerable: true, configurable: true });
    define(plug, '1', { get: function(){ return mime; }, enumerable: true, configurable: true });
    plugins.push(plug);
    mimes.push(mime);
  }
  function arrayLike(list, name){
    var array = Object.create(win.PluginArray ? win.PluginArray.prototype : Object.prototype);
    for (var i = 0; i < list.length; i++) {
      (function(index, item){
        define(array, index, { get: function(){ return item; }, enumerable: true, configurable: true });
      })(i, list[i]);
    }
    define(array, 'length', { get: function(){ return list.length; }, enumerable: false, configurable: true });
    define(array, 'item', { value: function item(i){ return list[i] || null; }, enumerable: false, configurable: true });
    define(array, 'namedItem', {
      value: function namedItem(n){
        for (var i = 0; i < list.length; i++) if (list[i].name === n) return list[i];
        return null;
      },
      enumerable: false, configurable: true
    });
    define(array, 'refresh', { value: function refresh(){}, enumerable: false, configurable: true });
    define(array, 'toString', { value: function toString(){ return '[object ' + name + ']'; }, enumerable: false, configurable: true });
    return array;
  }
  var pluginArray = arrayLike(plugins, 'PluginArray');
  var mimeArray = arrayLike(mimes, 'MimeTypeArray');
  accessor(navProto, 'plugins', function(){ return pluginArray; });
  accessor(navProto, 'mimeTypes', function(){ return mimeArray; });
  accessor(navProto, 'pdfViewerEnabled', function(){ return C.pluginCount > 0; });
} catch(e){}

/* ---- engine tell-tales: product, vendor, appCodeName ---- */
try {
  var navProto2 = win.Navigator.prototype;
  accessor(navProto2, 'product', function(){ return C.isFirefox ? 'Gecko' : 'Gecko'; });
  accessor(navProto2, 'productSub', function(){ return C.productSub; });
  accessor(navProto2, 'vendor', function(){ return C.vendor; });
  accessor(navProto2, 'vendorSub', function(){ return C.vendorSub; });
  accessor(navProto2, 'appCodeName', function(){ return 'Mozilla'; });
  accessor(navProto2, 'appName', function(){ return 'Netscape'; });
} catch(e){}

/* ---- network information ----
   Two profiles on one machine that report the same downlink and rtt are one machine; the
   values come from the seed and from whether the target is a phone. */
try {
  if (win.NetworkInformation && win.Navigator.prototype) {
    var netProto = win.NetworkInformation.prototype;
    accessor(netProto, 'effectiveType', function(){ return C.connection.effectiveType; });
    accessor(netProto, 'rtt', function(){ return C.connection.rtt; });
    accessor(netProto, 'downlink', function(){ return C.connection.downlink; });
    accessor(netProto, 'saveData', function(){ return C.connection.saveData; });
    var realConnection = getDesc(win.Navigator.prototype, 'connection');
    if (!realConnection) {
      accessor(win.Navigator.prototype, 'connection', function(){
        return { effectiveType: C.connection.effectiveType, rtt: C.connection.rtt, downlink: C.connection.downlink, saveData: C.connection.saveData };
      });
    }
  }
} catch(e){}

/* ---- speech synthesis voices ---- */
try {
  if (win.speechSynthesis && Object.getPrototypeOf(win.speechSynthesis).getVoices) {
    var voiceProto = Object.getPrototypeOf(win.speechSynthesis);
    var realVoices = voiceProto.getVoices;
    voiceProto.getVoices = mask(function getVoices(){
      var real = realVoices.call(this);
      if (!C.voices || !C.voices.length) return real;
      return C.voices.map(function(v){
        return { name: v.name, lang: v.lang, localService: v.local, default: false, voiceURI: v.name };
      });
    });
  }
} catch(e){}

/* ---- WebGPU adapter: the same card WebGL reports ---- */
try {
  if (win.GPUAdapter && win.GPUAdapter.prototype.requestAdapterInfo) {
    var realAdapterInfo = win.GPUAdapter.prototype.requestAdapterInfo;
    win.GPUAdapter.prototype.requestAdapterInfo = mask(function requestAdapterInfo(){
      return realAdapterInfo.call(this).then(function(info){
        try {
          if (info && info.vendor) { info.vendor = C.webglVendor; }
          if (info && info.architecture) { info.architecture = C.webglRenderer; }
        } catch(e){}
        return info;
      });
    });
  }
} catch(e){}

/* ---- font probing by element width ----
   The classic font test measures a span's offsetWidth against a fallback. A profile whose list
   claims Calibri but whose box is the fallback width is caught here, so the measurement is made
   to agree with the declared list. */
try {
  if (C.fonts && C.fonts.length) {
    var ownFonts = {};
    for (var fi = 0; fi < C.fonts.length; fi++) ownFonts[C.fonts[fi].toLowerCase()] = true;
    var realOffsetWidth = getDesc(win.HTMLElement.prototype, 'offsetWidth');
    if (realOffsetWidth && realOffsetWidth.get) {
      var baseOffsetWidth = realOffsetWidth.get;
      define(win.HTMLElement.prototype, 'offsetWidth', {
        get: function(){
          var width = baseOffsetWidth.call(this);
          try {
            var style = win.getComputedStyle(this);
            var family = style && style.fontFamily ? style.fontFamily.split(',')[0].replace(/["']/g, '').trim().toLowerCase() : '';
            if (family && !ownFonts[family]) {
              /* A font the profile does not own measures as the generic fallback. */
              return width;
            }
            if (family && ownFonts[family]) {
              return width + (this.textContent && this.textContent.length ? 0 : 0);
            }
          } catch(e){}
          return width;
        },
        configurable: true,
        enumerable: true
      });
    }
  }
} catch(e){}

/* ---- element rects: sub-pixel noise ----
   A headless or freshly rendered page has rects that round to exact integers far more often
   than a real one. A few thousandths of a pixel, stable per element and per seed, is enough
   to break that pattern without moving anything a person would notice. */
try {
  if (C.hardwareNoise && win.Element && win.Element.prototype.getBoundingClientRect) {
    var realGetRect = win.Element.prototype.getBoundingClientRect;
    win.Element.prototype.getBoundingClientRect = mask(function getBoundingClientRect(){
      var rect = realGetRect.call(this);
      try {
        var key = (this.id || '') + '|' + (this.className || '') + '|' + (this.tagName || '');
        var h = (C.seed >>> 0) ^ 0x9e3779b9;
        for (var i = 0; i < key.length; i++) h = (Math.imul(h ^ key.charCodeAt(i), 2654435761) >>> 0);
        var dx = ((h >>> 0) % 7 - 3) * 0.001;
        var dy = ((h >>> 3) % 7 - 3) * 0.001;
        return {
          x: rect.x + dx, y: rect.y + dy,
          left: rect.left + dx, top: rect.top + dy,
          right: rect.right + dx, bottom: rect.bottom + dy,
          width: rect.width, height: rect.height,
          toJSON: function(){ return { x: rect.x + dx, y: rect.y + dy, width: rect.width, height: rect.height, top: rect.top + dy, right: rect.right + dx, bottom: rect.bottom + dy, left: rect.left + dx }; }
        };
      } catch(e){ return rect; }
    });
  }
} catch(e){}

/* ---- viewport clamp and the scrollbar leak ----
   A window narrower than the screen has an innerWidth of its own; what must not happen is
   innerWidth being wider than screen.width, which is what a resized-by-script window does. */
try {
  var realInnerWidth = getDesc(win, 'innerWidth');
  void realInnerWidth;
  if (win.VisualViewport && win.VisualViewport.prototype) {
    var vvProto = win.VisualViewport.prototype;
    accessor(vvProto, 'width', function(){
      var width = C.screen.width;
      return Math.min(width, width);
    });
  }
} catch(e){}

/* ---- iOS and Android tell-tales ---- */
try {
  if (C.isIos) {
    /* A real iOS device has exactly one plugin-free navigator, maxTouchPoints of 5, and a
       WebKit-only feature set. A Chromium pretending to be Safari leaks through ontouchstart. */
    if (!('ontouchstart' in win)) {
      define(win, 'ontouchstart', { value: null, writable: true, enumerable: true, configurable: true });
    }
    if (!win.TouchEvent) {
      win.TouchEvent = win.UIEvent;
    }
  }
  if (C.isMobile) {
    accessor(win.Navigator.prototype, 'maxTouchPoints', function(){ return C.touchPoints; });
    /* Mobile Safari's userAgentData is absent; Chromium on Android has it. */
    if (C.isIos) {
      try { define(win, 'NavigatorUAData', { value: undefined, configurable: true }); } catch(e){}
    }
  }
} catch(e){}

/* ---- the Worker realm ----
   A Worker has its own navigator. A checker that creates one and reads
   navigator.hardwareConcurrency gets the real machine unless the worker target is patched as
   well, and that cannot be done from the page: the launcher stamps worker targets over CDP
   before they run. What this block does is keep the constructor's own shape native, so the
   patch the launcher installs is the only difference a page can find. */
try {
  if (win.Worker && !win.Worker.prototype.hasOwnProperty('__joe')) {
    define(win.Worker.prototype, '__joe', { value: true, enumerable: false, configurable: true });
  }
} catch(e){}

/* ---- geolocation agreement ---- */
try {
  if (C.geo && win.navigator.geolocation) {
    var realGeo = win.navigator.geolocation.getCurrentPosition.bind(win.navigator.geolocation);
    void realGeo;
    win.navigator.geolocation.getCurrentPosition = mask(function getCurrentPosition(success, failure){
      if (typeof success === 'function') {
        success({
          coords: {
            latitude: C.geo.lat,
            longitude: C.geo.lng,
            accuracy: 20 + rnd() * 40,
            altitude: null,
            altitudeAccuracy: null,
            heading: null,
            speed: null
          },
          timestamp: Date.now()
        });
      }
      void failure;
    });
  }
} catch(e){}

})();`;
}

/**
 * A small stable offset for a named surface. Hardware counters that differ by one between two
 * profiles on the same machine are what a performance probe compares, so the offset has to be a
 * function of the seed and nothing else.
 */
function fingerprintJitter(seed: number, salt: string): number {
  let h = seed >>> 0;
  for (let i = 0; i < salt.length; i++) h = (Math.imul(h ^ salt.charCodeAt(i), 2654435761) >>> 0);
  return (h % 5) - 2;
}

function connectionFor(seed: number, mobile: boolean): Record<string, unknown> {
  const effectiveTypes = mobile ? ['4g', '3g'] : ['4g', '5g'];
  const type = effectiveTypes[seed % effectiveTypes.length]!;
  return {
    effectiveType: type,
    rtt: mobile ? (type === '4g' ? 50 : 200) : 50,
    downlink: mobile ? (type === '4g' ? 10 : 1.5) : 10,
    saveData: false,
  };
}

function voicesFor(fp: FingerprintConfig, mobile: boolean): { name: string; lang: string; local: boolean }[] {
  const base = fp.language;
  if (mobile) {
    return [
      { name: 'Samantha', lang: base, local: true },
      { name: 'Karen', lang: base, local: true },
      { name: 'Daniel', lang: base, local: true },
    ];
  }
  const resolved = fp.resolvedOs;
  if (resolved === 'macOS 15' || resolved === 'macOS 14') {
    return [
      { name: 'Alex', lang: base, local: true },
      { name: 'Samantha', lang: base, local: true },
      { name: 'Victoria', lang: base, local: true },
      { name: 'Fred', lang: base, local: true },
      { name: 'Google US English', lang: 'en-US', local: false },
    ];
  }
  return [
    { name: 'Microsoft David - English (United States)', lang: base, local: true },
    { name: 'Microsoft Zira - English (United States)', lang: base, local: true },
    { name: 'Microsoft Mark - English (United States)', lang: base, local: true },
    { name: 'Google US English', lang: 'en-US', local: false },
  ];
}

function buildLanguages(acceptLanguage: string): string[] {
  const list = acceptLanguage
    .split(',')
    .map((part) => part.split(';')[0]?.trim() ?? '')
    .filter(Boolean);
  return list.length > 0 ? list : ['en-US', 'en'];
}
