"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// ../node_modules/.pnpm/ws@8.20.0/node_modules/ws/lib/constants.js
var require_constants = __commonJS({
  "../node_modules/.pnpm/ws@8.20.0/node_modules/ws/lib/constants.js"(exports2, module2) {
    "use strict";
    var BINARY_TYPES = ["nodebuffer", "arraybuffer", "fragments"];
    var hasBlob = typeof Blob !== "undefined";
    if (hasBlob) BINARY_TYPES.push("blob");
    module2.exports = {
      BINARY_TYPES,
      CLOSE_TIMEOUT: 3e4,
      EMPTY_BUFFER: Buffer.alloc(0),
      GUID: "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
      hasBlob,
      kForOnEventAttribute: /* @__PURE__ */ Symbol("kIsForOnEventAttribute"),
      kListener: /* @__PURE__ */ Symbol("kListener"),
      kStatusCode: /* @__PURE__ */ Symbol("status-code"),
      kWebSocket: /* @__PURE__ */ Symbol("websocket"),
      NOOP: () => {
      }
    };
  }
});

// ../node_modules/.pnpm/ws@8.20.0/node_modules/ws/lib/buffer-util.js
var require_buffer_util = __commonJS({
  "../node_modules/.pnpm/ws@8.20.0/node_modules/ws/lib/buffer-util.js"(exports2, module2) {
    "use strict";
    var { EMPTY_BUFFER } = require_constants();
    var FastBuffer = Buffer[Symbol.species];
    function concat(list, totalLength) {
      if (list.length === 0) return EMPTY_BUFFER;
      if (list.length === 1) return list[0];
      const target = Buffer.allocUnsafe(totalLength);
      let offset = 0;
      for (let i = 0; i < list.length; i++) {
        const buf = list[i];
        target.set(buf, offset);
        offset += buf.length;
      }
      if (offset < totalLength) {
        return new FastBuffer(target.buffer, target.byteOffset, offset);
      }
      return target;
    }
    function _mask(source, mask, output, offset, length) {
      for (let i = 0; i < length; i++) {
        output[offset + i] = source[i] ^ mask[i & 3];
      }
    }
    function _unmask(buffer, mask) {
      for (let i = 0; i < buffer.length; i++) {
        buffer[i] ^= mask[i & 3];
      }
    }
    function toArrayBuffer(buf) {
      if (buf.length === buf.buffer.byteLength) {
        return buf.buffer;
      }
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
    }
    function toBuffer(data) {
      toBuffer.readOnly = true;
      if (Buffer.isBuffer(data)) return data;
      let buf;
      if (data instanceof ArrayBuffer) {
        buf = new FastBuffer(data);
      } else if (ArrayBuffer.isView(data)) {
        buf = new FastBuffer(data.buffer, data.byteOffset, data.byteLength);
      } else {
        buf = Buffer.from(data);
        toBuffer.readOnly = false;
      }
      return buf;
    }
    module2.exports = {
      concat,
      mask: _mask,
      toArrayBuffer,
      toBuffer,
      unmask: _unmask
    };
    if (!process.env.WS_NO_BUFFER_UTIL) {
      try {
        const bufferUtil = require("bufferutil");
        module2.exports.mask = function(source, mask, output, offset, length) {
          if (length < 48) _mask(source, mask, output, offset, length);
          else bufferUtil.mask(source, mask, output, offset, length);
        };
        module2.exports.unmask = function(buffer, mask) {
          if (buffer.length < 32) _unmask(buffer, mask);
          else bufferUtil.unmask(buffer, mask);
        };
      } catch (e) {
      }
    }
  }
});

// ../node_modules/.pnpm/ws@8.20.0/node_modules/ws/lib/limiter.js
var require_limiter = __commonJS({
  "../node_modules/.pnpm/ws@8.20.0/node_modules/ws/lib/limiter.js"(exports2, module2) {
    "use strict";
    var kDone = /* @__PURE__ */ Symbol("kDone");
    var kRun = /* @__PURE__ */ Symbol("kRun");
    var Limiter = class {
      /**
       * Creates a new `Limiter`.
       *
       * @param {Number} [concurrency=Infinity] The maximum number of jobs allowed
       *     to run concurrently
       */
      constructor(concurrency) {
        this[kDone] = () => {
          this.pending--;
          this[kRun]();
        };
        this.concurrency = concurrency || Infinity;
        this.jobs = [];
        this.pending = 0;
      }
      /**
       * Adds a job to the queue.
       *
       * @param {Function} job The job to run
       * @public
       */
      add(job) {
        this.jobs.push(job);
        this[kRun]();
      }
      /**
       * Removes a job from the queue and runs it if possible.
       *
       * @private
       */
      [kRun]() {
        if (this.pending === this.concurrency) return;
        if (this.jobs.length) {
          const job = this.jobs.shift();
          this.pending++;
          job(this[kDone]);
        }
      }
    };
    module2.exports = Limiter;
  }
});

// ../node_modules/.pnpm/ws@8.20.0/node_modules/ws/lib/permessage-deflate.js
var require_permessage_deflate = __commonJS({
  "../node_modules/.pnpm/ws@8.20.0/node_modules/ws/lib/permessage-deflate.js"(exports2, module2) {
    "use strict";
    var zlib = require("zlib");
    var bufferUtil = require_buffer_util();
    var Limiter = require_limiter();
    var { kStatusCode } = require_constants();
    var FastBuffer = Buffer[Symbol.species];
    var TRAILER = Buffer.from([0, 0, 255, 255]);
    var kPerMessageDeflate = /* @__PURE__ */ Symbol("permessage-deflate");
    var kTotalLength = /* @__PURE__ */ Symbol("total-length");
    var kCallback = /* @__PURE__ */ Symbol("callback");
    var kBuffers = /* @__PURE__ */ Symbol("buffers");
    var kError = /* @__PURE__ */ Symbol("error");
    var zlibLimiter;
    var PerMessageDeflate2 = class {
      /**
       * Creates a PerMessageDeflate instance.
       *
       * @param {Object} [options] Configuration options
       * @param {(Boolean|Number)} [options.clientMaxWindowBits] Advertise support
       *     for, or request, a custom client window size
       * @param {Boolean} [options.clientNoContextTakeover=false] Advertise/
       *     acknowledge disabling of client context takeover
       * @param {Number} [options.concurrencyLimit=10] The number of concurrent
       *     calls to zlib
       * @param {Boolean} [options.isServer=false] Create the instance in either
       *     server or client mode
       * @param {Number} [options.maxPayload=0] The maximum allowed message length
       * @param {(Boolean|Number)} [options.serverMaxWindowBits] Request/confirm the
       *     use of a custom server window size
       * @param {Boolean} [options.serverNoContextTakeover=false] Request/accept
       *     disabling of server context takeover
       * @param {Number} [options.threshold=1024] Size (in bytes) below which
       *     messages should not be compressed if context takeover is disabled
       * @param {Object} [options.zlibDeflateOptions] Options to pass to zlib on
       *     deflate
       * @param {Object} [options.zlibInflateOptions] Options to pass to zlib on
       *     inflate
       */
      constructor(options) {
        this._options = options || {};
        this._threshold = this._options.threshold !== void 0 ? this._options.threshold : 1024;
        this._maxPayload = this._options.maxPayload | 0;
        this._isServer = !!this._options.isServer;
        this._deflate = null;
        this._inflate = null;
        this.params = null;
        if (!zlibLimiter) {
          const concurrency = this._options.concurrencyLimit !== void 0 ? this._options.concurrencyLimit : 10;
          zlibLimiter = new Limiter(concurrency);
        }
      }
      /**
       * @type {String}
       */
      static get extensionName() {
        return "permessage-deflate";
      }
      /**
       * Create an extension negotiation offer.
       *
       * @return {Object} Extension parameters
       * @public
       */
      offer() {
        const params = {};
        if (this._options.serverNoContextTakeover) {
          params.server_no_context_takeover = true;
        }
        if (this._options.clientNoContextTakeover) {
          params.client_no_context_takeover = true;
        }
        if (this._options.serverMaxWindowBits) {
          params.server_max_window_bits = this._options.serverMaxWindowBits;
        }
        if (this._options.clientMaxWindowBits) {
          params.client_max_window_bits = this._options.clientMaxWindowBits;
        } else if (this._options.clientMaxWindowBits == null) {
          params.client_max_window_bits = true;
        }
        return params;
      }
      /**
       * Accept an extension negotiation offer/response.
       *
       * @param {Array} configurations The extension negotiation offers/reponse
       * @return {Object} Accepted configuration
       * @public
       */
      accept(configurations) {
        configurations = this.normalizeParams(configurations);
        this.params = this._isServer ? this.acceptAsServer(configurations) : this.acceptAsClient(configurations);
        return this.params;
      }
      /**
       * Releases all resources used by the extension.
       *
       * @public
       */
      cleanup() {
        if (this._inflate) {
          this._inflate.close();
          this._inflate = null;
        }
        if (this._deflate) {
          const callback = this._deflate[kCallback];
          this._deflate.close();
          this._deflate = null;
          if (callback) {
            callback(
              new Error(
                "The deflate stream was closed while data was being processed"
              )
            );
          }
        }
      }
      /**
       *  Accept an extension negotiation offer.
       *
       * @param {Array} offers The extension negotiation offers
       * @return {Object} Accepted configuration
       * @private
       */
      acceptAsServer(offers) {
        const opts = this._options;
        const accepted = offers.find((params) => {
          if (opts.serverNoContextTakeover === false && params.server_no_context_takeover || params.server_max_window_bits && (opts.serverMaxWindowBits === false || typeof opts.serverMaxWindowBits === "number" && opts.serverMaxWindowBits > params.server_max_window_bits) || typeof opts.clientMaxWindowBits === "number" && !params.client_max_window_bits) {
            return false;
          }
          return true;
        });
        if (!accepted) {
          throw new Error("None of the extension offers can be accepted");
        }
        if (opts.serverNoContextTakeover) {
          accepted.server_no_context_takeover = true;
        }
        if (opts.clientNoContextTakeover) {
          accepted.client_no_context_takeover = true;
        }
        if (typeof opts.serverMaxWindowBits === "number") {
          accepted.server_max_window_bits = opts.serverMaxWindowBits;
        }
        if (typeof opts.clientMaxWindowBits === "number") {
          accepted.client_max_window_bits = opts.clientMaxWindowBits;
        } else if (accepted.client_max_window_bits === true || opts.clientMaxWindowBits === false) {
          delete accepted.client_max_window_bits;
        }
        return accepted;
      }
      /**
       * Accept the extension negotiation response.
       *
       * @param {Array} response The extension negotiation response
       * @return {Object} Accepted configuration
       * @private
       */
      acceptAsClient(response) {
        const params = response[0];
        if (this._options.clientNoContextTakeover === false && params.client_no_context_takeover) {
          throw new Error('Unexpected parameter "client_no_context_takeover"');
        }
        if (!params.client_max_window_bits) {
          if (typeof this._options.clientMaxWindowBits === "number") {
            params.client_max_window_bits = this._options.clientMaxWindowBits;
          }
        } else if (this._options.clientMaxWindowBits === false || typeof this._options.clientMaxWindowBits === "number" && params.client_max_window_bits > this._options.clientMaxWindowBits) {
          throw new Error(
            'Unexpected or invalid parameter "client_max_window_bits"'
          );
        }
        return params;
      }
      /**
       * Normalize parameters.
       *
       * @param {Array} configurations The extension negotiation offers/reponse
       * @return {Array} The offers/response with normalized parameters
       * @private
       */
      normalizeParams(configurations) {
        configurations.forEach((params) => {
          Object.keys(params).forEach((key) => {
            let value = params[key];
            if (value.length > 1) {
              throw new Error(`Parameter "${key}" must have only a single value`);
            }
            value = value[0];
            if (key === "client_max_window_bits") {
              if (value !== true) {
                const num = +value;
                if (!Number.isInteger(num) || num < 8 || num > 15) {
                  throw new TypeError(
                    `Invalid value for parameter "${key}": ${value}`
                  );
                }
                value = num;
              } else if (!this._isServer) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value}`
                );
              }
            } else if (key === "server_max_window_bits") {
              const num = +value;
              if (!Number.isInteger(num) || num < 8 || num > 15) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value}`
                );
              }
              value = num;
            } else if (key === "client_no_context_takeover" || key === "server_no_context_takeover") {
              if (value !== true) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value}`
                );
              }
            } else {
              throw new Error(`Unknown parameter "${key}"`);
            }
            params[key] = value;
          });
        });
        return configurations;
      }
      /**
       * Decompress data. Concurrency limited.
       *
       * @param {Buffer} data Compressed data
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @public
       */
      decompress(data, fin, callback) {
        zlibLimiter.add((done) => {
          this._decompress(data, fin, (err, result) => {
            done();
            callback(err, result);
          });
        });
      }
      /**
       * Compress data. Concurrency limited.
       *
       * @param {(Buffer|String)} data Data to compress
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @public
       */
      compress(data, fin, callback) {
        zlibLimiter.add((done) => {
          this._compress(data, fin, (err, result) => {
            done();
            callback(err, result);
          });
        });
      }
      /**
       * Decompress data.
       *
       * @param {Buffer} data Compressed data
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @private
       */
      _decompress(data, fin, callback) {
        const endpoint = this._isServer ? "client" : "server";
        if (!this._inflate) {
          const key = `${endpoint}_max_window_bits`;
          const windowBits = typeof this.params[key] !== "number" ? zlib.Z_DEFAULT_WINDOWBITS : this.params[key];
          this._inflate = zlib.createInflateRaw({
            ...this._options.zlibInflateOptions,
            windowBits
          });
          this._inflate[kPerMessageDeflate] = this;
          this._inflate[kTotalLength] = 0;
          this._inflate[kBuffers] = [];
          this._inflate.on("error", inflateOnError);
          this._inflate.on("data", inflateOnData);
        }
        this._inflate[kCallback] = callback;
        this._inflate.write(data);
        if (fin) this._inflate.write(TRAILER);
        this._inflate.flush(() => {
          const err = this._inflate[kError];
          if (err) {
            this._inflate.close();
            this._inflate = null;
            callback(err);
            return;
          }
          const data2 = bufferUtil.concat(
            this._inflate[kBuffers],
            this._inflate[kTotalLength]
          );
          if (this._inflate._readableState.endEmitted) {
            this._inflate.close();
            this._inflate = null;
          } else {
            this._inflate[kTotalLength] = 0;
            this._inflate[kBuffers] = [];
            if (fin && this.params[`${endpoint}_no_context_takeover`]) {
              this._inflate.reset();
            }
          }
          callback(null, data2);
        });
      }
      /**
       * Compress data.
       *
       * @param {(Buffer|String)} data Data to compress
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @private
       */
      _compress(data, fin, callback) {
        const endpoint = this._isServer ? "server" : "client";
        if (!this._deflate) {
          const key = `${endpoint}_max_window_bits`;
          const windowBits = typeof this.params[key] !== "number" ? zlib.Z_DEFAULT_WINDOWBITS : this.params[key];
          this._deflate = zlib.createDeflateRaw({
            ...this._options.zlibDeflateOptions,
            windowBits
          });
          this._deflate[kTotalLength] = 0;
          this._deflate[kBuffers] = [];
          this._deflate.on("data", deflateOnData);
        }
        this._deflate[kCallback] = callback;
        this._deflate.write(data);
        this._deflate.flush(zlib.Z_SYNC_FLUSH, () => {
          if (!this._deflate) {
            return;
          }
          let data2 = bufferUtil.concat(
            this._deflate[kBuffers],
            this._deflate[kTotalLength]
          );
          if (fin) {
            data2 = new FastBuffer(data2.buffer, data2.byteOffset, data2.length - 4);
          }
          this._deflate[kCallback] = null;
          this._deflate[kTotalLength] = 0;
          this._deflate[kBuffers] = [];
          if (fin && this.params[`${endpoint}_no_context_takeover`]) {
            this._deflate.reset();
          }
          callback(null, data2);
        });
      }
    };
    module2.exports = PerMessageDeflate2;
    function deflateOnData(chunk) {
      this[kBuffers].push(chunk);
      this[kTotalLength] += chunk.length;
    }
    function inflateOnData(chunk) {
      this[kTotalLength] += chunk.length;
      if (this[kPerMessageDeflate]._maxPayload < 1 || this[kTotalLength] <= this[kPerMessageDeflate]._maxPayload) {
        this[kBuffers].push(chunk);
        return;
      }
      this[kError] = new RangeError("Max payload size exceeded");
      this[kError].code = "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH";
      this[kError][kStatusCode] = 1009;
      this.removeListener("data", inflateOnData);
      this.reset();
    }
    function inflateOnError(err) {
      this[kPerMessageDeflate]._inflate = null;
      if (this[kError]) {
        this[kCallback](this[kError]);
        return;
      }
      err[kStatusCode] = 1007;
      this[kCallback](err);
    }
  }
});

// ../node_modules/.pnpm/ws@8.20.0/node_modules/ws/lib/validation.js
var require_validation = __commonJS({
  "../node_modules/.pnpm/ws@8.20.0/node_modules/ws/lib/validation.js"(exports2, module2) {
    "use strict";
    var { isUtf8 } = require("buffer");
    var { hasBlob } = require_constants();
    var tokenChars = [
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      // 0 - 15
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      // 16 - 31
      0,
      1,
      0,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      1,
      1,
      0,
      1,
      1,
      0,
      // 32 - 47
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      0,
      0,
      0,
      0,
      // 48 - 63
      0,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      // 64 - 79
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      0,
      1,
      1,
      // 80 - 95
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      // 96 - 111
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      1,
      0,
      1,
      0
      // 112 - 127
    ];
    function isValidStatusCode(code) {
      return code >= 1e3 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006 || code >= 3e3 && code <= 4999;
    }
    function _isValidUTF8(buf) {
      const len = buf.length;
      let i = 0;
      while (i < len) {
        if ((buf[i] & 128) === 0) {
          i++;
        } else if ((buf[i] & 224) === 192) {
          if (i + 1 === len || (buf[i + 1] & 192) !== 128 || (buf[i] & 254) === 192) {
            return false;
          }
          i += 2;
        } else if ((buf[i] & 240) === 224) {
          if (i + 2 >= len || (buf[i + 1] & 192) !== 128 || (buf[i + 2] & 192) !== 128 || buf[i] === 224 && (buf[i + 1] & 224) === 128 || // Overlong
          buf[i] === 237 && (buf[i + 1] & 224) === 160) {
            return false;
          }
          i += 3;
        } else if ((buf[i] & 248) === 240) {
          if (i + 3 >= len || (buf[i + 1] & 192) !== 128 || (buf[i + 2] & 192) !== 128 || (buf[i + 3] & 192) !== 128 || buf[i] === 240 && (buf[i + 1] & 240) === 128 || // Overlong
          buf[i] === 244 && buf[i + 1] > 143 || buf[i] > 244) {
            return false;
          }
          i += 4;
        } else {
          return false;
        }
      }
      return true;
    }
    function isBlob(value) {
      return hasBlob && typeof value === "object" && typeof value.arrayBuffer === "function" && typeof value.type === "string" && typeof value.stream === "function" && (value[Symbol.toStringTag] === "Blob" || value[Symbol.toStringTag] === "File");
    }
    module2.exports = {
      isBlob,
      isValidStatusCode,
      isValidUTF8: _isValidUTF8,
      tokenChars
    };
    if (isUtf8) {
      module2.exports.isValidUTF8 = function(buf) {
        return buf.length < 24 ? _isValidUTF8(buf) : isUtf8(buf);
      };
    } else if (!process.env.WS_NO_UTF_8_VALIDATE) {
      try {
        const isValidUTF8 = require("utf-8-validate");
        module2.exports.isValidUTF8 = function(buf) {
          return buf.length < 32 ? _isValidUTF8(buf) : isValidUTF8(buf);
        };
      } catch (e) {
      }
    }
  }
});

// ../node_modules/.pnpm/ws@8.20.0/node_modules/ws/lib/receiver.js
var require_receiver = __commonJS({
  "../node_modules/.pnpm/ws@8.20.0/node_modules/ws/lib/receiver.js"(exports2, module2) {
    "use strict";
    var { Writable } = require("stream");
    var PerMessageDeflate2 = require_permessage_deflate();
    var {
      BINARY_TYPES,
      EMPTY_BUFFER,
      kStatusCode,
      kWebSocket
    } = require_constants();
    var { concat, toArrayBuffer, unmask } = require_buffer_util();
    var { isValidStatusCode, isValidUTF8 } = require_validation();
    var FastBuffer = Buffer[Symbol.species];
    var GET_INFO = 0;
    var GET_PAYLOAD_LENGTH_16 = 1;
    var GET_PAYLOAD_LENGTH_64 = 2;
    var GET_MASK = 3;
    var GET_DATA = 4;
    var INFLATING = 5;
    var DEFER_EVENT = 6;
    var Receiver2 = class extends Writable {
      /**
       * Creates a Receiver instance.
       *
       * @param {Object} [options] Options object
       * @param {Boolean} [options.allowSynchronousEvents=true] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {String} [options.binaryType=nodebuffer] The type for binary data
       * @param {Object} [options.extensions] An object containing the negotiated
       *     extensions
       * @param {Boolean} [options.isServer=false] Specifies whether to operate in
       *     client or server mode
       * @param {Number} [options.maxPayload=0] The maximum allowed message length
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       */
      constructor(options = {}) {
        super();
        this._allowSynchronousEvents = options.allowSynchronousEvents !== void 0 ? options.allowSynchronousEvents : true;
        this._binaryType = options.binaryType || BINARY_TYPES[0];
        this._extensions = options.extensions || {};
        this._isServer = !!options.isServer;
        this._maxPayload = options.maxPayload | 0;
        this._skipUTF8Validation = !!options.skipUTF8Validation;
        this[kWebSocket] = void 0;
        this._bufferedBytes = 0;
        this._buffers = [];
        this._compressed = false;
        this._payloadLength = 0;
        this._mask = void 0;
        this._fragmented = 0;
        this._masked = false;
        this._fin = false;
        this._opcode = 0;
        this._totalPayloadLength = 0;
        this._messageLength = 0;
        this._fragments = [];
        this._errored = false;
        this._loop = false;
        this._state = GET_INFO;
      }
      /**
       * Implements `Writable.prototype._write()`.
       *
       * @param {Buffer} chunk The chunk of data to write
       * @param {String} encoding The character encoding of `chunk`
       * @param {Function} cb Callback
       * @private
       */
      _write(chunk, encoding, cb) {
        if (this._opcode === 8 && this._state == GET_INFO) return cb();
        this._bufferedBytes += chunk.length;
        this._buffers.push(chunk);
        this.startLoop(cb);
      }
      /**
       * Consumes `n` bytes from the buffered data.
       *
       * @param {Number} n The number of bytes to consume
       * @return {Buffer} The consumed bytes
       * @private
       */
      consume(n) {
        this._bufferedBytes -= n;
        if (n === this._buffers[0].length) return this._buffers.shift();
        if (n < this._buffers[0].length) {
          const buf = this._buffers[0];
          this._buffers[0] = new FastBuffer(
            buf.buffer,
            buf.byteOffset + n,
            buf.length - n
          );
          return new FastBuffer(buf.buffer, buf.byteOffset, n);
        }
        const dst = Buffer.allocUnsafe(n);
        do {
          const buf = this._buffers[0];
          const offset = dst.length - n;
          if (n >= buf.length) {
            dst.set(this._buffers.shift(), offset);
          } else {
            dst.set(new Uint8Array(buf.buffer, buf.byteOffset, n), offset);
            this._buffers[0] = new FastBuffer(
              buf.buffer,
              buf.byteOffset + n,
              buf.length - n
            );
          }
          n -= buf.length;
        } while (n > 0);
        return dst;
      }
      /**
       * Starts the parsing loop.
       *
       * @param {Function} cb Callback
       * @private
       */
      startLoop(cb) {
        this._loop = true;
        do {
          switch (this._state) {
            case GET_INFO:
              this.getInfo(cb);
              break;
            case GET_PAYLOAD_LENGTH_16:
              this.getPayloadLength16(cb);
              break;
            case GET_PAYLOAD_LENGTH_64:
              this.getPayloadLength64(cb);
              break;
            case GET_MASK:
              this.getMask();
              break;
            case GET_DATA:
              this.getData(cb);
              break;
            case INFLATING:
            case DEFER_EVENT:
              this._loop = false;
              return;
          }
        } while (this._loop);
        if (!this._errored) cb();
      }
      /**
       * Reads the first two bytes of a frame.
       *
       * @param {Function} cb Callback
       * @private
       */
      getInfo(cb) {
        if (this._bufferedBytes < 2) {
          this._loop = false;
          return;
        }
        const buf = this.consume(2);
        if ((buf[0] & 48) !== 0) {
          const error = this.createError(
            RangeError,
            "RSV2 and RSV3 must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_RSV_2_3"
          );
          cb(error);
          return;
        }
        const compressed = (buf[0] & 64) === 64;
        if (compressed && !this._extensions[PerMessageDeflate2.extensionName]) {
          const error = this.createError(
            RangeError,
            "RSV1 must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_RSV_1"
          );
          cb(error);
          return;
        }
        this._fin = (buf[0] & 128) === 128;
        this._opcode = buf[0] & 15;
        this._payloadLength = buf[1] & 127;
        if (this._opcode === 0) {
          if (compressed) {
            const error = this.createError(
              RangeError,
              "RSV1 must be clear",
              true,
              1002,
              "WS_ERR_UNEXPECTED_RSV_1"
            );
            cb(error);
            return;
          }
          if (!this._fragmented) {
            const error = this.createError(
              RangeError,
              "invalid opcode 0",
              true,
              1002,
              "WS_ERR_INVALID_OPCODE"
            );
            cb(error);
            return;
          }
          this._opcode = this._fragmented;
        } else if (this._opcode === 1 || this._opcode === 2) {
          if (this._fragmented) {
            const error = this.createError(
              RangeError,
              `invalid opcode ${this._opcode}`,
              true,
              1002,
              "WS_ERR_INVALID_OPCODE"
            );
            cb(error);
            return;
          }
          this._compressed = compressed;
        } else if (this._opcode > 7 && this._opcode < 11) {
          if (!this._fin) {
            const error = this.createError(
              RangeError,
              "FIN must be set",
              true,
              1002,
              "WS_ERR_EXPECTED_FIN"
            );
            cb(error);
            return;
          }
          if (compressed) {
            const error = this.createError(
              RangeError,
              "RSV1 must be clear",
              true,
              1002,
              "WS_ERR_UNEXPECTED_RSV_1"
            );
            cb(error);
            return;
          }
          if (this._payloadLength > 125 || this._opcode === 8 && this._payloadLength === 1) {
            const error = this.createError(
              RangeError,
              `invalid payload length ${this._payloadLength}`,
              true,
              1002,
              "WS_ERR_INVALID_CONTROL_PAYLOAD_LENGTH"
            );
            cb(error);
            return;
          }
        } else {
          const error = this.createError(
            RangeError,
            `invalid opcode ${this._opcode}`,
            true,
            1002,
            "WS_ERR_INVALID_OPCODE"
          );
          cb(error);
          return;
        }
        if (!this._fin && !this._fragmented) this._fragmented = this._opcode;
        this._masked = (buf[1] & 128) === 128;
        if (this._isServer) {
          if (!this._masked) {
            const error = this.createError(
              RangeError,
              "MASK must be set",
              true,
              1002,
              "WS_ERR_EXPECTED_MASK"
            );
            cb(error);
            return;
          }
        } else if (this._masked) {
          const error = this.createError(
            RangeError,
            "MASK must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_MASK"
          );
          cb(error);
          return;
        }
        if (this._payloadLength === 126) this._state = GET_PAYLOAD_LENGTH_16;
        else if (this._payloadLength === 127) this._state = GET_PAYLOAD_LENGTH_64;
        else this.haveLength(cb);
      }
      /**
       * Gets extended payload length (7+16).
       *
       * @param {Function} cb Callback
       * @private
       */
      getPayloadLength16(cb) {
        if (this._bufferedBytes < 2) {
          this._loop = false;
          return;
        }
        this._payloadLength = this.consume(2).readUInt16BE(0);
        this.haveLength(cb);
      }
      /**
       * Gets extended payload length (7+64).
       *
       * @param {Function} cb Callback
       * @private
       */
      getPayloadLength64(cb) {
        if (this._bufferedBytes < 8) {
          this._loop = false;
          return;
        }
        const buf = this.consume(8);
        const num = buf.readUInt32BE(0);
        if (num > Math.pow(2, 53 - 32) - 1) {
          const error = this.createError(
            RangeError,
            "Unsupported WebSocket frame: payload length > 2^53 - 1",
            false,
            1009,
            "WS_ERR_UNSUPPORTED_DATA_PAYLOAD_LENGTH"
          );
          cb(error);
          return;
        }
        this._payloadLength = num * Math.pow(2, 32) + buf.readUInt32BE(4);
        this.haveLength(cb);
      }
      /**
       * Payload length has been read.
       *
       * @param {Function} cb Callback
       * @private
       */
      haveLength(cb) {
        if (this._payloadLength && this._opcode < 8) {
          this._totalPayloadLength += this._payloadLength;
          if (this._totalPayloadLength > this._maxPayload && this._maxPayload > 0) {
            const error = this.createError(
              RangeError,
              "Max payload size exceeded",
              false,
              1009,
              "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
            );
            cb(error);
            return;
          }
        }
        if (this._masked) this._state = GET_MASK;
        else this._state = GET_DATA;
      }
      /**
       * Reads mask bytes.
       *
       * @private
       */
      getMask() {
        if (this._bufferedBytes < 4) {
          this._loop = false;
          return;
        }
        this._mask = this.consume(4);
        this._state = GET_DATA;
      }
      /**
       * Reads data bytes.
       *
       * @param {Function} cb Callback
       * @private
       */
      getData(cb) {
        let data = EMPTY_BUFFER;
        if (this._payloadLength) {
          if (this._bufferedBytes < this._payloadLength) {
            this._loop = false;
            return;
          }
          data = this.consume(this._payloadLength);
          if (this._masked && (this._mask[0] | this._mask[1] | this._mask[2] | this._mask[3]) !== 0) {
            unmask(data, this._mask);
          }
        }
        if (this._opcode > 7) {
          this.controlMessage(data, cb);
          return;
        }
        if (this._compressed) {
          this._state = INFLATING;
          this.decompress(data, cb);
          return;
        }
        if (data.length) {
          this._messageLength = this._totalPayloadLength;
          this._fragments.push(data);
        }
        this.dataMessage(cb);
      }
      /**
       * Decompresses data.
       *
       * @param {Buffer} data Compressed data
       * @param {Function} cb Callback
       * @private
       */
      decompress(data, cb) {
        const perMessageDeflate = this._extensions[PerMessageDeflate2.extensionName];
        perMessageDeflate.decompress(data, this._fin, (err, buf) => {
          if (err) return cb(err);
          if (buf.length) {
            this._messageLength += buf.length;
            if (this._messageLength > this._maxPayload && this._maxPayload > 0) {
              const error = this.createError(
                RangeError,
                "Max payload size exceeded",
                false,
                1009,
                "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
              );
              cb(error);
              return;
            }
            this._fragments.push(buf);
          }
          this.dataMessage(cb);
          if (this._state === GET_INFO) this.startLoop(cb);
        });
      }
      /**
       * Handles a data message.
       *
       * @param {Function} cb Callback
       * @private
       */
      dataMessage(cb) {
        if (!this._fin) {
          this._state = GET_INFO;
          return;
        }
        const messageLength = this._messageLength;
        const fragments = this._fragments;
        this._totalPayloadLength = 0;
        this._messageLength = 0;
        this._fragmented = 0;
        this._fragments = [];
        if (this._opcode === 2) {
          let data;
          if (this._binaryType === "nodebuffer") {
            data = concat(fragments, messageLength);
          } else if (this._binaryType === "arraybuffer") {
            data = toArrayBuffer(concat(fragments, messageLength));
          } else if (this._binaryType === "blob") {
            data = new Blob(fragments);
          } else {
            data = fragments;
          }
          if (this._allowSynchronousEvents) {
            this.emit("message", data, true);
            this._state = GET_INFO;
          } else {
            this._state = DEFER_EVENT;
            setImmediate(() => {
              this.emit("message", data, true);
              this._state = GET_INFO;
              this.startLoop(cb);
            });
          }
        } else {
          const buf = concat(fragments, messageLength);
          if (!this._skipUTF8Validation && !isValidUTF8(buf)) {
            const error = this.createError(
              Error,
              "invalid UTF-8 sequence",
              true,
              1007,
              "WS_ERR_INVALID_UTF8"
            );
            cb(error);
            return;
          }
          if (this._state === INFLATING || this._allowSynchronousEvents) {
            this.emit("message", buf, false);
            this._state = GET_INFO;
          } else {
            this._state = DEFER_EVENT;
            setImmediate(() => {
              this.emit("message", buf, false);
              this._state = GET_INFO;
              this.startLoop(cb);
            });
          }
        }
      }
      /**
       * Handles a control message.
       *
       * @param {Buffer} data Data to handle
       * @return {(Error|RangeError|undefined)} A possible error
       * @private
       */
      controlMessage(data, cb) {
        if (this._opcode === 8) {
          if (data.length === 0) {
            this._loop = false;
            this.emit("conclude", 1005, EMPTY_BUFFER);
            this.end();
          } else {
            const code = data.readUInt16BE(0);
            if (!isValidStatusCode(code)) {
              const error = this.createError(
                RangeError,
                `invalid status code ${code}`,
                true,
                1002,
                "WS_ERR_INVALID_CLOSE_CODE"
              );
              cb(error);
              return;
            }
            const buf = new FastBuffer(
              data.buffer,
              data.byteOffset + 2,
              data.length - 2
            );
            if (!this._skipUTF8Validation && !isValidUTF8(buf)) {
              const error = this.createError(
                Error,
                "invalid UTF-8 sequence",
                true,
                1007,
                "WS_ERR_INVALID_UTF8"
              );
              cb(error);
              return;
            }
            this._loop = false;
            this.emit("conclude", code, buf);
            this.end();
          }
          this._state = GET_INFO;
          return;
        }
        if (this._allowSynchronousEvents) {
          this.emit(this._opcode === 9 ? "ping" : "pong", data);
          this._state = GET_INFO;
        } else {
          this._state = DEFER_EVENT;
          setImmediate(() => {
            this.emit(this._opcode === 9 ? "ping" : "pong", data);
            this._state = GET_INFO;
            this.startLoop(cb);
          });
        }
      }
      /**
       * Builds an error object.
       *
       * @param {function(new:Error|RangeError)} ErrorCtor The error constructor
       * @param {String} message The error message
       * @param {Boolean} prefix Specifies whether or not to add a default prefix to
       *     `message`
       * @param {Number} statusCode The status code
       * @param {String} errorCode The exposed error code
       * @return {(Error|RangeError)} The error
       * @private
       */
      createError(ErrorCtor, message, prefix, statusCode, errorCode) {
        this._loop = false;
        this._errored = true;
        const err = new ErrorCtor(
          prefix ? `Invalid WebSocket frame: ${message}` : message
        );
        Error.captureStackTrace(err, this.createError);
        err.code = errorCode;
        err[kStatusCode] = statusCode;
        return err;
      }
    };
    module2.exports = Receiver2;
  }
});

// ../node_modules/.pnpm/ws@8.20.0/node_modules/ws/lib/sender.js
var require_sender = __commonJS({
  "../node_modules/.pnpm/ws@8.20.0/node_modules/ws/lib/sender.js"(exports2, module2) {
    "use strict";
    var { Duplex } = require("stream");
    var { randomFillSync } = require("crypto");
    var PerMessageDeflate2 = require_permessage_deflate();
    var { EMPTY_BUFFER, kWebSocket, NOOP } = require_constants();
    var { isBlob, isValidStatusCode } = require_validation();
    var { mask: applyMask, toBuffer } = require_buffer_util();
    var kByteLength = /* @__PURE__ */ Symbol("kByteLength");
    var maskBuffer = Buffer.alloc(4);
    var RANDOM_POOL_SIZE = 8 * 1024;
    var randomPool;
    var randomPoolPointer = RANDOM_POOL_SIZE;
    var DEFAULT = 0;
    var DEFLATING = 1;
    var GET_BLOB_DATA = 2;
    var Sender2 = class _Sender {
      /**
       * Creates a Sender instance.
       *
       * @param {Duplex} socket The connection socket
       * @param {Object} [extensions] An object containing the negotiated extensions
       * @param {Function} [generateMask] The function used to generate the masking
       *     key
       */
      constructor(socket, extensions, generateMask) {
        this._extensions = extensions || {};
        if (generateMask) {
          this._generateMask = generateMask;
          this._maskBuffer = Buffer.alloc(4);
        }
        this._socket = socket;
        this._firstFragment = true;
        this._compress = false;
        this._bufferedBytes = 0;
        this._queue = [];
        this._state = DEFAULT;
        this.onerror = NOOP;
        this[kWebSocket] = void 0;
      }
      /**
       * Frames a piece of data according to the HyBi WebSocket protocol.
       *
       * @param {(Buffer|String)} data The data to frame
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @return {(Buffer|String)[]} The framed data
       * @public
       */
      static frame(data, options) {
        let mask;
        let merge = false;
        let offset = 2;
        let skipMasking = false;
        if (options.mask) {
          mask = options.maskBuffer || maskBuffer;
          if (options.generateMask) {
            options.generateMask(mask);
          } else {
            if (randomPoolPointer === RANDOM_POOL_SIZE) {
              if (randomPool === void 0) {
                randomPool = Buffer.alloc(RANDOM_POOL_SIZE);
              }
              randomFillSync(randomPool, 0, RANDOM_POOL_SIZE);
              randomPoolPointer = 0;
            }
            mask[0] = randomPool[randomPoolPointer++];
            mask[1] = randomPool[randomPoolPointer++];
            mask[2] = randomPool[randomPoolPointer++];
            mask[3] = randomPool[randomPoolPointer++];
          }
          skipMasking = (mask[0] | mask[1] | mask[2] | mask[3]) === 0;
          offset = 6;
        }
        let dataLength;
        if (typeof data === "string") {
          if ((!options.mask || skipMasking) && options[kByteLength] !== void 0) {
            dataLength = options[kByteLength];
          } else {
            data = Buffer.from(data);
            dataLength = data.length;
          }
        } else {
          dataLength = data.length;
          merge = options.mask && options.readOnly && !skipMasking;
        }
        let payloadLength = dataLength;
        if (dataLength >= 65536) {
          offset += 8;
          payloadLength = 127;
        } else if (dataLength > 125) {
          offset += 2;
          payloadLength = 126;
        }
        const target = Buffer.allocUnsafe(merge ? dataLength + offset : offset);
        target[0] = options.fin ? options.opcode | 128 : options.opcode;
        if (options.rsv1) target[0] |= 64;
        target[1] = payloadLength;
        if (payloadLength === 126) {
          target.writeUInt16BE(dataLength, 2);
        } else if (payloadLength === 127) {
          target[2] = target[3] = 0;
          target.writeUIntBE(dataLength, 4, 6);
        }
        if (!options.mask) return [target, data];
        target[1] |= 128;
        target[offset - 4] = mask[0];
        target[offset - 3] = mask[1];
        target[offset - 2] = mask[2];
        target[offset - 1] = mask[3];
        if (skipMasking) return [target, data];
        if (merge) {
          applyMask(data, mask, target, offset, dataLength);
          return [target];
        }
        applyMask(data, mask, data, 0, dataLength);
        return [target, data];
      }
      /**
       * Sends a close message to the other peer.
       *
       * @param {Number} [code] The status code component of the body
       * @param {(String|Buffer)} [data] The message component of the body
       * @param {Boolean} [mask=false] Specifies whether or not to mask the message
       * @param {Function} [cb] Callback
       * @public
       */
      close(code, data, mask, cb) {
        let buf;
        if (code === void 0) {
          buf = EMPTY_BUFFER;
        } else if (typeof code !== "number" || !isValidStatusCode(code)) {
          throw new TypeError("First argument must be a valid error code number");
        } else if (data === void 0 || !data.length) {
          buf = Buffer.allocUnsafe(2);
          buf.writeUInt16BE(code, 0);
        } else {
          const length = Buffer.byteLength(data);
          if (length > 123) {
            throw new RangeError("The message must not be greater than 123 bytes");
          }
          buf = Buffer.allocUnsafe(2 + length);
          buf.writeUInt16BE(code, 0);
          if (typeof data === "string") {
            buf.write(data, 2);
          } else {
            buf.set(data, 2);
          }
        }
        const options = {
          [kByteLength]: buf.length,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 8,
          readOnly: false,
          rsv1: false
        };
        if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, buf, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(buf, options), cb);
        }
      }
      /**
       * Sends a ping message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Boolean} [mask=false] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback
       * @public
       */
      ping(data, mask, cb) {
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (byteLength > 125) {
          throw new RangeError("The data size must not be greater than 125 bytes");
        }
        const options = {
          [kByteLength]: byteLength,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 9,
          readOnly,
          rsv1: false
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, false, options, cb]);
          } else {
            this.getBlobData(data, false, options, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(data, options), cb);
        }
      }
      /**
       * Sends a pong message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Boolean} [mask=false] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback
       * @public
       */
      pong(data, mask, cb) {
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (byteLength > 125) {
          throw new RangeError("The data size must not be greater than 125 bytes");
        }
        const options = {
          [kByteLength]: byteLength,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 10,
          readOnly,
          rsv1: false
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, false, options, cb]);
          } else {
            this.getBlobData(data, false, options, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(data, options), cb);
        }
      }
      /**
       * Sends a data message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Object} options Options object
       * @param {Boolean} [options.binary=false] Specifies whether `data` is binary
       *     or text
       * @param {Boolean} [options.compress=false] Specifies whether or not to
       *     compress `data`
       * @param {Boolean} [options.fin=false] Specifies whether the fragment is the
       *     last one
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Function} [cb] Callback
       * @public
       */
      send(data, options, cb) {
        const perMessageDeflate = this._extensions[PerMessageDeflate2.extensionName];
        let opcode = options.binary ? 2 : 1;
        let rsv1 = options.compress;
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (this._firstFragment) {
          this._firstFragment = false;
          if (rsv1 && perMessageDeflate && perMessageDeflate.params[perMessageDeflate._isServer ? "server_no_context_takeover" : "client_no_context_takeover"]) {
            rsv1 = byteLength >= perMessageDeflate._threshold;
          }
          this._compress = rsv1;
        } else {
          rsv1 = false;
          opcode = 0;
        }
        if (options.fin) this._firstFragment = true;
        const opts = {
          [kByteLength]: byteLength,
          fin: options.fin,
          generateMask: this._generateMask,
          mask: options.mask,
          maskBuffer: this._maskBuffer,
          opcode,
          readOnly,
          rsv1
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, this._compress, opts, cb]);
          } else {
            this.getBlobData(data, this._compress, opts, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, this._compress, opts, cb]);
        } else {
          this.dispatch(data, this._compress, opts, cb);
        }
      }
      /**
       * Gets the contents of a blob as binary data.
       *
       * @param {Blob} blob The blob
       * @param {Boolean} [compress=false] Specifies whether or not to compress
       *     the data
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @param {Function} [cb] Callback
       * @private
       */
      getBlobData(blob, compress, options, cb) {
        this._bufferedBytes += options[kByteLength];
        this._state = GET_BLOB_DATA;
        blob.arrayBuffer().then((arrayBuffer) => {
          if (this._socket.destroyed) {
            const err = new Error(
              "The socket was closed while the blob was being read"
            );
            process.nextTick(callCallbacks, this, err, cb);
            return;
          }
          this._bufferedBytes -= options[kByteLength];
          const data = toBuffer(arrayBuffer);
          if (!compress) {
            this._state = DEFAULT;
            this.sendFrame(_Sender.frame(data, options), cb);
            this.dequeue();
          } else {
            this.dispatch(data, compress, options, cb);
          }
        }).catch((err) => {
          process.nextTick(onError, this, err, cb);
        });
      }
      /**
       * Dispatches a message.
       *
       * @param {(Buffer|String)} data The message to send
       * @param {Boolean} [compress=false] Specifies whether or not to compress
       *     `data`
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @param {Function} [cb] Callback
       * @private
       */
      dispatch(data, compress, options, cb) {
        if (!compress) {
          this.sendFrame(_Sender.frame(data, options), cb);
          return;
        }
        const perMessageDeflate = this._extensions[PerMessageDeflate2.extensionName];
        this._bufferedBytes += options[kByteLength];
        this._state = DEFLATING;
        perMessageDeflate.compress(data, options.fin, (_, buf) => {
          if (this._socket.destroyed) {
            const err = new Error(
              "The socket was closed while data was being compressed"
            );
            callCallbacks(this, err, cb);
            return;
          }
          this._bufferedBytes -= options[kByteLength];
          this._state = DEFAULT;
          options.readOnly = false;
          this.sendFrame(_Sender.frame(buf, options), cb);
          this.dequeue();
        });
      }
      /**
       * Executes queued send operations.
       *
       * @private
       */
      dequeue() {
        while (this._state === DEFAULT && this._queue.length) {
          const params = this._queue.shift();
          this._bufferedBytes -= params[3][kByteLength];
          Reflect.apply(params[0], this, params.slice(1));
        }
      }
      /**
       * Enqueues a send operation.
       *
       * @param {Array} params Send operation parameters.
       * @private
       */
      enqueue(params) {
        this._bufferedBytes += params[3][kByteLength];
        this._queue.push(params);
      }
      /**
       * Sends a frame.
       *
       * @param {(Buffer | String)[]} list The frame to send
       * @param {Function} [cb] Callback
       * @private
       */
      sendFrame(list, cb) {
        if (list.length === 2) {
          this._socket.cork();
          this._socket.write(list[0]);
          this._socket.write(list[1], cb);
          this._socket.uncork();
        } else {
          this._socket.write(list[0], cb);
        }
      }
    };
    module2.exports = Sender2;
    function callCallbacks(sender, err, cb) {
      if (typeof cb === "function") cb(err);
      for (let i = 0; i < sender._queue.length; i++) {
        const params = sender._queue[i];
        const callback = params[params.length - 1];
        if (typeof callback === "function") callback(err);
      }
    }
    function onError(sender, err, cb) {
      callCallbacks(sender, err, cb);
      sender.onerror(err);
    }
  }
});

// ../node_modules/.pnpm/ws@8.20.0/node_modules/ws/lib/event-target.js
var require_event_target = __commonJS({
  "../node_modules/.pnpm/ws@8.20.0/node_modules/ws/lib/event-target.js"(exports2, module2) {
    "use strict";
    var { kForOnEventAttribute, kListener } = require_constants();
    var kCode = /* @__PURE__ */ Symbol("kCode");
    var kData = /* @__PURE__ */ Symbol("kData");
    var kError = /* @__PURE__ */ Symbol("kError");
    var kMessage = /* @__PURE__ */ Symbol("kMessage");
    var kReason = /* @__PURE__ */ Symbol("kReason");
    var kTarget = /* @__PURE__ */ Symbol("kTarget");
    var kType = /* @__PURE__ */ Symbol("kType");
    var kWasClean = /* @__PURE__ */ Symbol("kWasClean");
    var Event = class {
      /**
       * Create a new `Event`.
       *
       * @param {String} type The name of the event
       * @throws {TypeError} If the `type` argument is not specified
       */
      constructor(type) {
        this[kTarget] = null;
        this[kType] = type;
      }
      /**
       * @type {*}
       */
      get target() {
        return this[kTarget];
      }
      /**
       * @type {String}
       */
      get type() {
        return this[kType];
      }
    };
    Object.defineProperty(Event.prototype, "target", { enumerable: true });
    Object.defineProperty(Event.prototype, "type", { enumerable: true });
    var CloseEvent = class extends Event {
      /**
       * Create a new `CloseEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {Number} [options.code=0] The status code explaining why the
       *     connection was closed
       * @param {String} [options.reason=''] A human-readable string explaining why
       *     the connection was closed
       * @param {Boolean} [options.wasClean=false] Indicates whether or not the
       *     connection was cleanly closed
       */
      constructor(type, options = {}) {
        super(type);
        this[kCode] = options.code === void 0 ? 0 : options.code;
        this[kReason] = options.reason === void 0 ? "" : options.reason;
        this[kWasClean] = options.wasClean === void 0 ? false : options.wasClean;
      }
      /**
       * @type {Number}
       */
      get code() {
        return this[kCode];
      }
      /**
       * @type {String}
       */
      get reason() {
        return this[kReason];
      }
      /**
       * @type {Boolean}
       */
      get wasClean() {
        return this[kWasClean];
      }
    };
    Object.defineProperty(CloseEvent.prototype, "code", { enumerable: true });
    Object.defineProperty(CloseEvent.prototype, "reason", { enumerable: true });
    Object.defineProperty(CloseEvent.prototype, "wasClean", { enumerable: true });
    var ErrorEvent = class extends Event {
      /**
       * Create a new `ErrorEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {*} [options.error=null] The error that generated this event
       * @param {String} [options.message=''] The error message
       */
      constructor(type, options = {}) {
        super(type);
        this[kError] = options.error === void 0 ? null : options.error;
        this[kMessage] = options.message === void 0 ? "" : options.message;
      }
      /**
       * @type {*}
       */
      get error() {
        return this[kError];
      }
      /**
       * @type {String}
       */
      get message() {
        return this[kMessage];
      }
    };
    Object.defineProperty(ErrorEvent.prototype, "error", { enumerable: true });
    Object.defineProperty(ErrorEvent.prototype, "message", { enumerable: true });
    var MessageEvent = class extends Event {
      /**
       * Create a new `MessageEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {*} [options.data=null] The message content
       */
      constructor(type, options = {}) {
        super(type);
        this[kData] = options.data === void 0 ? null : options.data;
      }
      /**
       * @type {*}
       */
      get data() {
        return this[kData];
      }
    };
    Object.defineProperty(MessageEvent.prototype, "data", { enumerable: true });
    var EventTarget = {
      /**
       * Register an event listener.
       *
       * @param {String} type A string representing the event type to listen for
       * @param {(Function|Object)} handler The listener to add
       * @param {Object} [options] An options object specifies characteristics about
       *     the event listener
       * @param {Boolean} [options.once=false] A `Boolean` indicating that the
       *     listener should be invoked at most once after being added. If `true`,
       *     the listener would be automatically removed when invoked.
       * @public
       */
      addEventListener(type, handler, options = {}) {
        for (const listener of this.listeners(type)) {
          if (!options[kForOnEventAttribute] && listener[kListener] === handler && !listener[kForOnEventAttribute]) {
            return;
          }
        }
        let wrapper;
        if (type === "message") {
          wrapper = function onMessage(data, isBinary) {
            const event = new MessageEvent("message", {
              data: isBinary ? data : data.toString()
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "close") {
          wrapper = function onClose(code, message) {
            const event = new CloseEvent("close", {
              code,
              reason: message.toString(),
              wasClean: this._closeFrameReceived && this._closeFrameSent
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "error") {
          wrapper = function onError(error) {
            const event = new ErrorEvent("error", {
              error,
              message: error.message
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "open") {
          wrapper = function onOpen() {
            const event = new Event("open");
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else {
          return;
        }
        wrapper[kForOnEventAttribute] = !!options[kForOnEventAttribute];
        wrapper[kListener] = handler;
        if (options.once) {
          this.once(type, wrapper);
        } else {
          this.on(type, wrapper);
        }
      },
      /**
       * Remove an event listener.
       *
       * @param {String} type A string representing the event type to remove
       * @param {(Function|Object)} handler The listener to remove
       * @public
       */
      removeEventListener(type, handler) {
        for (const listener of this.listeners(type)) {
          if (listener[kListener] === handler && !listener[kForOnEventAttribute]) {
            this.removeListener(type, listener);
            break;
          }
        }
      }
    };
    module2.exports = {
      CloseEvent,
      ErrorEvent,
      Event,
      EventTarget,
      MessageEvent
    };
    function callListener(listener, thisArg, event) {
      if (typeof listener === "object" && listener.handleEvent) {
        listener.handleEvent.call(listener, event);
      } else {
        listener.call(thisArg, event);
      }
    }
  }
});

// ../node_modules/.pnpm/ws@8.20.0/node_modules/ws/lib/extension.js
var require_extension = __commonJS({
  "../node_modules/.pnpm/ws@8.20.0/node_modules/ws/lib/extension.js"(exports2, module2) {
    "use strict";
    var { tokenChars } = require_validation();
    function push(dest, name, elem) {
      if (dest[name] === void 0) dest[name] = [elem];
      else dest[name].push(elem);
    }
    function parse(header) {
      const offers = /* @__PURE__ */ Object.create(null);
      let params = /* @__PURE__ */ Object.create(null);
      let mustUnescape = false;
      let isEscaping = false;
      let inQuotes = false;
      let extensionName;
      let paramName;
      let start = -1;
      let code = -1;
      let end = -1;
      let i = 0;
      for (; i < header.length; i++) {
        code = header.charCodeAt(i);
        if (extensionName === void 0) {
          if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (i !== 0 && (code === 32 || code === 9)) {
            if (end === -1 && start !== -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            const name = header.slice(start, end);
            if (code === 44) {
              push(offers, name, params);
              params = /* @__PURE__ */ Object.create(null);
            } else {
              extensionName = name;
            }
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        } else if (paramName === void 0) {
          if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (code === 32 || code === 9) {
            if (end === -1 && start !== -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            push(params, header.slice(start, end), true);
            if (code === 44) {
              push(offers, extensionName, params);
              params = /* @__PURE__ */ Object.create(null);
              extensionName = void 0;
            }
            start = end = -1;
          } else if (code === 61 && start !== -1 && end === -1) {
            paramName = header.slice(start, i);
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        } else {
          if (isEscaping) {
            if (tokenChars[code] !== 1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (start === -1) start = i;
            else if (!mustUnescape) mustUnescape = true;
            isEscaping = false;
          } else if (inQuotes) {
            if (tokenChars[code] === 1) {
              if (start === -1) start = i;
            } else if (code === 34 && start !== -1) {
              inQuotes = false;
              end = i;
            } else if (code === 92) {
              isEscaping = true;
            } else {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
          } else if (code === 34 && header.charCodeAt(i - 1) === 61) {
            inQuotes = true;
          } else if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (start !== -1 && (code === 32 || code === 9)) {
            if (end === -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            let value = header.slice(start, end);
            if (mustUnescape) {
              value = value.replace(/\\/g, "");
              mustUnescape = false;
            }
            push(params, paramName, value);
            if (code === 44) {
              push(offers, extensionName, params);
              params = /* @__PURE__ */ Object.create(null);
              extensionName = void 0;
            }
            paramName = void 0;
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        }
      }
      if (start === -1 || inQuotes || code === 32 || code === 9) {
        throw new SyntaxError("Unexpected end of input");
      }
      if (end === -1) end = i;
      const token = header.slice(start, end);
      if (extensionName === void 0) {
        push(offers, token, params);
      } else {
        if (paramName === void 0) {
          push(params, token, true);
        } else if (mustUnescape) {
          push(params, paramName, token.replace(/\\/g, ""));
        } else {
          push(params, paramName, token);
        }
        push(offers, extensionName, params);
      }
      return offers;
    }
    function format(extensions) {
      return Object.keys(extensions).map((extension2) => {
        let configurations = extensions[extension2];
        if (!Array.isArray(configurations)) configurations = [configurations];
        return configurations.map((params) => {
          return [extension2].concat(
            Object.keys(params).map((k) => {
              let values = params[k];
              if (!Array.isArray(values)) values = [values];
              return values.map((v) => v === true ? k : `${k}=${v}`).join("; ");
            })
          ).join("; ");
        }).join(", ");
      }).join(", ");
    }
    module2.exports = { format, parse };
  }
});

// ../node_modules/.pnpm/ws@8.20.0/node_modules/ws/lib/websocket.js
var require_websocket = __commonJS({
  "../node_modules/.pnpm/ws@8.20.0/node_modules/ws/lib/websocket.js"(exports2, module2) {
    "use strict";
    var EventEmitter = require("events");
    var https = require("https");
    var http = require("http");
    var net = require("net");
    var tls = require("tls");
    var { randomBytes: randomBytes2, createHash } = require("crypto");
    var { Duplex, Readable } = require("stream");
    var { URL: URL2 } = require("url");
    var PerMessageDeflate2 = require_permessage_deflate();
    var Receiver2 = require_receiver();
    var Sender2 = require_sender();
    var { isBlob } = require_validation();
    var {
      BINARY_TYPES,
      CLOSE_TIMEOUT,
      EMPTY_BUFFER,
      GUID,
      kForOnEventAttribute,
      kListener,
      kStatusCode,
      kWebSocket,
      NOOP
    } = require_constants();
    var {
      EventTarget: { addEventListener, removeEventListener }
    } = require_event_target();
    var { format, parse } = require_extension();
    var { toBuffer } = require_buffer_util();
    var kAborted = /* @__PURE__ */ Symbol("kAborted");
    var protocolVersions = [8, 13];
    var readyStates = ["CONNECTING", "OPEN", "CLOSING", "CLOSED"];
    var subprotocolRegex = /^[!#$%&'*+\-.0-9A-Z^_`|a-z~]+$/;
    var WebSocket2 = class _WebSocket extends EventEmitter {
      /**
       * Create a new `WebSocket`.
       *
       * @param {(String|URL)} address The URL to which to connect
       * @param {(String|String[])} [protocols] The subprotocols
       * @param {Object} [options] Connection options
       */
      constructor(address, protocols, options) {
        super();
        this._binaryType = BINARY_TYPES[0];
        this._closeCode = 1006;
        this._closeFrameReceived = false;
        this._closeFrameSent = false;
        this._closeMessage = EMPTY_BUFFER;
        this._closeTimer = null;
        this._errorEmitted = false;
        this._extensions = {};
        this._paused = false;
        this._protocol = "";
        this._readyState = _WebSocket.CONNECTING;
        this._receiver = null;
        this._sender = null;
        this._socket = null;
        if (address !== null) {
          this._bufferedAmount = 0;
          this._isServer = false;
          this._redirects = 0;
          if (protocols === void 0) {
            protocols = [];
          } else if (!Array.isArray(protocols)) {
            if (typeof protocols === "object" && protocols !== null) {
              options = protocols;
              protocols = [];
            } else {
              protocols = [protocols];
            }
          }
          initAsClient(this, address, protocols, options);
        } else {
          this._autoPong = options.autoPong;
          this._closeTimeout = options.closeTimeout;
          this._isServer = true;
        }
      }
      /**
       * For historical reasons, the custom "nodebuffer" type is used by the default
       * instead of "blob".
       *
       * @type {String}
       */
      get binaryType() {
        return this._binaryType;
      }
      set binaryType(type) {
        if (!BINARY_TYPES.includes(type)) return;
        this._binaryType = type;
        if (this._receiver) this._receiver._binaryType = type;
      }
      /**
       * @type {Number}
       */
      get bufferedAmount() {
        if (!this._socket) return this._bufferedAmount;
        return this._socket._writableState.length + this._sender._bufferedBytes;
      }
      /**
       * @type {String}
       */
      get extensions() {
        return Object.keys(this._extensions).join();
      }
      /**
       * @type {Boolean}
       */
      get isPaused() {
        return this._paused;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onclose() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onerror() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onopen() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onmessage() {
        return null;
      }
      /**
       * @type {String}
       */
      get protocol() {
        return this._protocol;
      }
      /**
       * @type {Number}
       */
      get readyState() {
        return this._readyState;
      }
      /**
       * @type {String}
       */
      get url() {
        return this._url;
      }
      /**
       * Set up the socket and the internal resources.
       *
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Object} options Options object
       * @param {Boolean} [options.allowSynchronousEvents=false] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Number} [options.maxPayload=0] The maximum allowed message size
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       * @private
       */
      setSocket(socket, head, options) {
        const receiver = new Receiver2({
          allowSynchronousEvents: options.allowSynchronousEvents,
          binaryType: this.binaryType,
          extensions: this._extensions,
          isServer: this._isServer,
          maxPayload: options.maxPayload,
          skipUTF8Validation: options.skipUTF8Validation
        });
        const sender = new Sender2(socket, this._extensions, options.generateMask);
        this._receiver = receiver;
        this._sender = sender;
        this._socket = socket;
        receiver[kWebSocket] = this;
        sender[kWebSocket] = this;
        socket[kWebSocket] = this;
        receiver.on("conclude", receiverOnConclude);
        receiver.on("drain", receiverOnDrain);
        receiver.on("error", receiverOnError);
        receiver.on("message", receiverOnMessage);
        receiver.on("ping", receiverOnPing);
        receiver.on("pong", receiverOnPong);
        sender.onerror = senderOnError;
        if (socket.setTimeout) socket.setTimeout(0);
        if (socket.setNoDelay) socket.setNoDelay();
        if (head.length > 0) socket.unshift(head);
        socket.on("close", socketOnClose);
        socket.on("data", socketOnData);
        socket.on("end", socketOnEnd);
        socket.on("error", socketOnError);
        this._readyState = _WebSocket.OPEN;
        this.emit("open");
      }
      /**
       * Emit the `'close'` event.
       *
       * @private
       */
      emitClose() {
        if (!this._socket) {
          this._readyState = _WebSocket.CLOSED;
          this.emit("close", this._closeCode, this._closeMessage);
          return;
        }
        if (this._extensions[PerMessageDeflate2.extensionName]) {
          this._extensions[PerMessageDeflate2.extensionName].cleanup();
        }
        this._receiver.removeAllListeners();
        this._readyState = _WebSocket.CLOSED;
        this.emit("close", this._closeCode, this._closeMessage);
      }
      /**
       * Start a closing handshake.
       *
       *          +----------+   +-----------+   +----------+
       *     - - -|ws.close()|-->|close frame|-->|ws.close()|- - -
       *    |     +----------+   +-----------+   +----------+     |
       *          +----------+   +-----------+         |
       * CLOSING  |ws.close()|<--|close frame|<--+-----+       CLOSING
       *          +----------+   +-----------+   |
       *    |           |                        |   +---+        |
       *                +------------------------+-->|fin| - - - -
       *    |         +---+                      |   +---+
       *     - - - - -|fin|<---------------------+
       *              +---+
       *
       * @param {Number} [code] Status code explaining why the connection is closing
       * @param {(String|Buffer)} [data] The reason why the connection is
       *     closing
       * @public
       */
      close(code, data) {
        if (this.readyState === _WebSocket.CLOSED) return;
        if (this.readyState === _WebSocket.CONNECTING) {
          const msg = "WebSocket was closed before the connection was established";
          abortHandshake(this, this._req, msg);
          return;
        }
        if (this.readyState === _WebSocket.CLOSING) {
          if (this._closeFrameSent && (this._closeFrameReceived || this._receiver._writableState.errorEmitted)) {
            this._socket.end();
          }
          return;
        }
        this._readyState = _WebSocket.CLOSING;
        this._sender.close(code, data, !this._isServer, (err) => {
          if (err) return;
          this._closeFrameSent = true;
          if (this._closeFrameReceived || this._receiver._writableState.errorEmitted) {
            this._socket.end();
          }
        });
        setCloseTimer(this);
      }
      /**
       * Pause the socket.
       *
       * @public
       */
      pause() {
        if (this.readyState === _WebSocket.CONNECTING || this.readyState === _WebSocket.CLOSED) {
          return;
        }
        this._paused = true;
        this._socket.pause();
      }
      /**
       * Send a ping.
       *
       * @param {*} [data] The data to send
       * @param {Boolean} [mask] Indicates whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when the ping is sent
       * @public
       */
      ping(data, mask, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof data === "function") {
          cb = data;
          data = mask = void 0;
        } else if (typeof mask === "function") {
          cb = mask;
          mask = void 0;
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        if (mask === void 0) mask = !this._isServer;
        this._sender.ping(data || EMPTY_BUFFER, mask, cb);
      }
      /**
       * Send a pong.
       *
       * @param {*} [data] The data to send
       * @param {Boolean} [mask] Indicates whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when the pong is sent
       * @public
       */
      pong(data, mask, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof data === "function") {
          cb = data;
          data = mask = void 0;
        } else if (typeof mask === "function") {
          cb = mask;
          mask = void 0;
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        if (mask === void 0) mask = !this._isServer;
        this._sender.pong(data || EMPTY_BUFFER, mask, cb);
      }
      /**
       * Resume the socket.
       *
       * @public
       */
      resume() {
        if (this.readyState === _WebSocket.CONNECTING || this.readyState === _WebSocket.CLOSED) {
          return;
        }
        this._paused = false;
        if (!this._receiver._writableState.needDrain) this._socket.resume();
      }
      /**
       * Send a data message.
       *
       * @param {*} data The message to send
       * @param {Object} [options] Options object
       * @param {Boolean} [options.binary] Specifies whether `data` is binary or
       *     text
       * @param {Boolean} [options.compress] Specifies whether or not to compress
       *     `data`
       * @param {Boolean} [options.fin=true] Specifies whether the fragment is the
       *     last one
       * @param {Boolean} [options.mask] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when data is written out
       * @public
       */
      send(data, options, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof options === "function") {
          cb = options;
          options = {};
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        const opts = {
          binary: typeof data !== "string",
          mask: !this._isServer,
          compress: true,
          fin: true,
          ...options
        };
        if (!this._extensions[PerMessageDeflate2.extensionName]) {
          opts.compress = false;
        }
        this._sender.send(data || EMPTY_BUFFER, opts, cb);
      }
      /**
       * Forcibly close the connection.
       *
       * @public
       */
      terminate() {
        if (this.readyState === _WebSocket.CLOSED) return;
        if (this.readyState === _WebSocket.CONNECTING) {
          const msg = "WebSocket was closed before the connection was established";
          abortHandshake(this, this._req, msg);
          return;
        }
        if (this._socket) {
          this._readyState = _WebSocket.CLOSING;
          this._socket.destroy();
        }
      }
    };
    Object.defineProperty(WebSocket2, "CONNECTING", {
      enumerable: true,
      value: readyStates.indexOf("CONNECTING")
    });
    Object.defineProperty(WebSocket2.prototype, "CONNECTING", {
      enumerable: true,
      value: readyStates.indexOf("CONNECTING")
    });
    Object.defineProperty(WebSocket2, "OPEN", {
      enumerable: true,
      value: readyStates.indexOf("OPEN")
    });
    Object.defineProperty(WebSocket2.prototype, "OPEN", {
      enumerable: true,
      value: readyStates.indexOf("OPEN")
    });
    Object.defineProperty(WebSocket2, "CLOSING", {
      enumerable: true,
      value: readyStates.indexOf("CLOSING")
    });
    Object.defineProperty(WebSocket2.prototype, "CLOSING", {
      enumerable: true,
      value: readyStates.indexOf("CLOSING")
    });
    Object.defineProperty(WebSocket2, "CLOSED", {
      enumerable: true,
      value: readyStates.indexOf("CLOSED")
    });
    Object.defineProperty(WebSocket2.prototype, "CLOSED", {
      enumerable: true,
      value: readyStates.indexOf("CLOSED")
    });
    [
      "binaryType",
      "bufferedAmount",
      "extensions",
      "isPaused",
      "protocol",
      "readyState",
      "url"
    ].forEach((property) => {
      Object.defineProperty(WebSocket2.prototype, property, { enumerable: true });
    });
    ["open", "error", "close", "message"].forEach((method) => {
      Object.defineProperty(WebSocket2.prototype, `on${method}`, {
        enumerable: true,
        get() {
          for (const listener of this.listeners(method)) {
            if (listener[kForOnEventAttribute]) return listener[kListener];
          }
          return null;
        },
        set(handler) {
          for (const listener of this.listeners(method)) {
            if (listener[kForOnEventAttribute]) {
              this.removeListener(method, listener);
              break;
            }
          }
          if (typeof handler !== "function") return;
          this.addEventListener(method, handler, {
            [kForOnEventAttribute]: true
          });
        }
      });
    });
    WebSocket2.prototype.addEventListener = addEventListener;
    WebSocket2.prototype.removeEventListener = removeEventListener;
    module2.exports = WebSocket2;
    function initAsClient(websocket, address, protocols, options) {
      const opts = {
        allowSynchronousEvents: true,
        autoPong: true,
        closeTimeout: CLOSE_TIMEOUT,
        protocolVersion: protocolVersions[1],
        maxPayload: 100 * 1024 * 1024,
        skipUTF8Validation: false,
        perMessageDeflate: true,
        followRedirects: false,
        maxRedirects: 10,
        ...options,
        socketPath: void 0,
        hostname: void 0,
        protocol: void 0,
        timeout: void 0,
        method: "GET",
        host: void 0,
        path: void 0,
        port: void 0
      };
      websocket._autoPong = opts.autoPong;
      websocket._closeTimeout = opts.closeTimeout;
      if (!protocolVersions.includes(opts.protocolVersion)) {
        throw new RangeError(
          `Unsupported protocol version: ${opts.protocolVersion} (supported versions: ${protocolVersions.join(", ")})`
        );
      }
      let parsedUrl;
      if (address instanceof URL2) {
        parsedUrl = address;
      } else {
        try {
          parsedUrl = new URL2(address);
        } catch {
          throw new SyntaxError(`Invalid URL: ${address}`);
        }
      }
      if (parsedUrl.protocol === "http:") {
        parsedUrl.protocol = "ws:";
      } else if (parsedUrl.protocol === "https:") {
        parsedUrl.protocol = "wss:";
      }
      websocket._url = parsedUrl.href;
      const isSecure = parsedUrl.protocol === "wss:";
      const isIpcUrl = parsedUrl.protocol === "ws+unix:";
      let invalidUrlMessage;
      if (parsedUrl.protocol !== "ws:" && !isSecure && !isIpcUrl) {
        invalidUrlMessage = `The URL's protocol must be one of "ws:", "wss:", "http:", "https:", or "ws+unix:"`;
      } else if (isIpcUrl && !parsedUrl.pathname) {
        invalidUrlMessage = "The URL's pathname is empty";
      } else if (parsedUrl.hash) {
        invalidUrlMessage = "The URL contains a fragment identifier";
      }
      if (invalidUrlMessage) {
        const err = new SyntaxError(invalidUrlMessage);
        if (websocket._redirects === 0) {
          throw err;
        } else {
          emitErrorAndClose(websocket, err);
          return;
        }
      }
      const defaultPort = isSecure ? 443 : 80;
      const key = randomBytes2(16).toString("base64");
      const request = isSecure ? https.request : http.request;
      const protocolSet = /* @__PURE__ */ new Set();
      let perMessageDeflate;
      opts.createConnection = opts.createConnection || (isSecure ? tlsConnect : netConnect);
      opts.defaultPort = opts.defaultPort || defaultPort;
      opts.port = parsedUrl.port || defaultPort;
      opts.host = parsedUrl.hostname.startsWith("[") ? parsedUrl.hostname.slice(1, -1) : parsedUrl.hostname;
      opts.headers = {
        ...opts.headers,
        "Sec-WebSocket-Version": opts.protocolVersion,
        "Sec-WebSocket-Key": key,
        Connection: "Upgrade",
        Upgrade: "websocket"
      };
      opts.path = parsedUrl.pathname + parsedUrl.search;
      opts.timeout = opts.handshakeTimeout;
      if (opts.perMessageDeflate) {
        perMessageDeflate = new PerMessageDeflate2({
          ...opts.perMessageDeflate,
          isServer: false,
          maxPayload: opts.maxPayload
        });
        opts.headers["Sec-WebSocket-Extensions"] = format({
          [PerMessageDeflate2.extensionName]: perMessageDeflate.offer()
        });
      }
      if (protocols.length) {
        for (const protocol of protocols) {
          if (typeof protocol !== "string" || !subprotocolRegex.test(protocol) || protocolSet.has(protocol)) {
            throw new SyntaxError(
              "An invalid or duplicated subprotocol was specified"
            );
          }
          protocolSet.add(protocol);
        }
        opts.headers["Sec-WebSocket-Protocol"] = protocols.join(",");
      }
      if (opts.origin) {
        if (opts.protocolVersion < 13) {
          opts.headers["Sec-WebSocket-Origin"] = opts.origin;
        } else {
          opts.headers.Origin = opts.origin;
        }
      }
      if (parsedUrl.username || parsedUrl.password) {
        opts.auth = `${parsedUrl.username}:${parsedUrl.password}`;
      }
      if (isIpcUrl) {
        const parts = opts.path.split(":");
        opts.socketPath = parts[0];
        opts.path = parts[1];
      }
      let req;
      if (opts.followRedirects) {
        if (websocket._redirects === 0) {
          websocket._originalIpc = isIpcUrl;
          websocket._originalSecure = isSecure;
          websocket._originalHostOrSocketPath = isIpcUrl ? opts.socketPath : parsedUrl.host;
          const headers = options && options.headers;
          options = { ...options, headers: {} };
          if (headers) {
            for (const [key2, value] of Object.entries(headers)) {
              options.headers[key2.toLowerCase()] = value;
            }
          }
        } else if (websocket.listenerCount("redirect") === 0) {
          const isSameHost = isIpcUrl ? websocket._originalIpc ? opts.socketPath === websocket._originalHostOrSocketPath : false : websocket._originalIpc ? false : parsedUrl.host === websocket._originalHostOrSocketPath;
          if (!isSameHost || websocket._originalSecure && !isSecure) {
            delete opts.headers.authorization;
            delete opts.headers.cookie;
            if (!isSameHost) delete opts.headers.host;
            opts.auth = void 0;
          }
        }
        if (opts.auth && !options.headers.authorization) {
          options.headers.authorization = "Basic " + Buffer.from(opts.auth).toString("base64");
        }
        req = websocket._req = request(opts);
        if (websocket._redirects) {
          websocket.emit("redirect", websocket.url, req);
        }
      } else {
        req = websocket._req = request(opts);
      }
      if (opts.timeout) {
        req.on("timeout", () => {
          abortHandshake(websocket, req, "Opening handshake has timed out");
        });
      }
      req.on("error", (err) => {
        if (req === null || req[kAborted]) return;
        req = websocket._req = null;
        emitErrorAndClose(websocket, err);
      });
      req.on("response", (res) => {
        const location = res.headers.location;
        const statusCode = res.statusCode;
        if (location && opts.followRedirects && statusCode >= 300 && statusCode < 400) {
          if (++websocket._redirects > opts.maxRedirects) {
            abortHandshake(websocket, req, "Maximum redirects exceeded");
            return;
          }
          req.abort();
          let addr;
          try {
            addr = new URL2(location, address);
          } catch (e) {
            const err = new SyntaxError(`Invalid URL: ${location}`);
            emitErrorAndClose(websocket, err);
            return;
          }
          initAsClient(websocket, addr, protocols, options);
        } else if (!websocket.emit("unexpected-response", req, res)) {
          abortHandshake(
            websocket,
            req,
            `Unexpected server response: ${res.statusCode}`
          );
        }
      });
      req.on("upgrade", (res, socket, head) => {
        websocket.emit("upgrade", res);
        if (websocket.readyState !== WebSocket2.CONNECTING) return;
        req = websocket._req = null;
        const upgrade = res.headers.upgrade;
        if (upgrade === void 0 || upgrade.toLowerCase() !== "websocket") {
          abortHandshake(websocket, socket, "Invalid Upgrade header");
          return;
        }
        const digest = createHash("sha1").update(key + GUID).digest("base64");
        if (res.headers["sec-websocket-accept"] !== digest) {
          abortHandshake(websocket, socket, "Invalid Sec-WebSocket-Accept header");
          return;
        }
        const serverProt = res.headers["sec-websocket-protocol"];
        let protError;
        if (serverProt !== void 0) {
          if (!protocolSet.size) {
            protError = "Server sent a subprotocol but none was requested";
          } else if (!protocolSet.has(serverProt)) {
            protError = "Server sent an invalid subprotocol";
          }
        } else if (protocolSet.size) {
          protError = "Server sent no subprotocol";
        }
        if (protError) {
          abortHandshake(websocket, socket, protError);
          return;
        }
        if (serverProt) websocket._protocol = serverProt;
        const secWebSocketExtensions = res.headers["sec-websocket-extensions"];
        if (secWebSocketExtensions !== void 0) {
          if (!perMessageDeflate) {
            const message = "Server sent a Sec-WebSocket-Extensions header but no extension was requested";
            abortHandshake(websocket, socket, message);
            return;
          }
          let extensions;
          try {
            extensions = parse(secWebSocketExtensions);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Extensions header";
            abortHandshake(websocket, socket, message);
            return;
          }
          const extensionNames = Object.keys(extensions);
          if (extensionNames.length !== 1 || extensionNames[0] !== PerMessageDeflate2.extensionName) {
            const message = "Server indicated an extension that was not requested";
            abortHandshake(websocket, socket, message);
            return;
          }
          try {
            perMessageDeflate.accept(extensions[PerMessageDeflate2.extensionName]);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Extensions header";
            abortHandshake(websocket, socket, message);
            return;
          }
          websocket._extensions[PerMessageDeflate2.extensionName] = perMessageDeflate;
        }
        websocket.setSocket(socket, head, {
          allowSynchronousEvents: opts.allowSynchronousEvents,
          generateMask: opts.generateMask,
          maxPayload: opts.maxPayload,
          skipUTF8Validation: opts.skipUTF8Validation
        });
      });
      if (opts.finishRequest) {
        opts.finishRequest(req, websocket);
      } else {
        req.end();
      }
    }
    function emitErrorAndClose(websocket, err) {
      websocket._readyState = WebSocket2.CLOSING;
      websocket._errorEmitted = true;
      websocket.emit("error", err);
      websocket.emitClose();
    }
    function netConnect(options) {
      options.path = options.socketPath;
      return net.connect(options);
    }
    function tlsConnect(options) {
      options.path = void 0;
      if (!options.servername && options.servername !== "") {
        options.servername = net.isIP(options.host) ? "" : options.host;
      }
      return tls.connect(options);
    }
    function abortHandshake(websocket, stream, message) {
      websocket._readyState = WebSocket2.CLOSING;
      const err = new Error(message);
      Error.captureStackTrace(err, abortHandshake);
      if (stream.setHeader) {
        stream[kAborted] = true;
        stream.abort();
        if (stream.socket && !stream.socket.destroyed) {
          stream.socket.destroy();
        }
        process.nextTick(emitErrorAndClose, websocket, err);
      } else {
        stream.destroy(err);
        stream.once("error", websocket.emit.bind(websocket, "error"));
        stream.once("close", websocket.emitClose.bind(websocket));
      }
    }
    function sendAfterClose(websocket, data, cb) {
      if (data) {
        const length = isBlob(data) ? data.size : toBuffer(data).length;
        if (websocket._socket) websocket._sender._bufferedBytes += length;
        else websocket._bufferedAmount += length;
      }
      if (cb) {
        const err = new Error(
          `WebSocket is not open: readyState ${websocket.readyState} (${readyStates[websocket.readyState]})`
        );
        process.nextTick(cb, err);
      }
    }
    function receiverOnConclude(code, reason) {
      const websocket = this[kWebSocket];
      websocket._closeFrameReceived = true;
      websocket._closeMessage = reason;
      websocket._closeCode = code;
      if (websocket._socket[kWebSocket] === void 0) return;
      websocket._socket.removeListener("data", socketOnData);
      process.nextTick(resume, websocket._socket);
      if (code === 1005) websocket.close();
      else websocket.close(code, reason);
    }
    function receiverOnDrain() {
      const websocket = this[kWebSocket];
      if (!websocket.isPaused) websocket._socket.resume();
    }
    function receiverOnError(err) {
      const websocket = this[kWebSocket];
      if (websocket._socket[kWebSocket] !== void 0) {
        websocket._socket.removeListener("data", socketOnData);
        process.nextTick(resume, websocket._socket);
        websocket.close(err[kStatusCode]);
      }
      if (!websocket._errorEmitted) {
        websocket._errorEmitted = true;
        websocket.emit("error", err);
      }
    }
    function receiverOnFinish() {
      this[kWebSocket].emitClose();
    }
    function receiverOnMessage(data, isBinary) {
      this[kWebSocket].emit("message", data, isBinary);
    }
    function receiverOnPing(data) {
      const websocket = this[kWebSocket];
      if (websocket._autoPong) websocket.pong(data, !this._isServer, NOOP);
      websocket.emit("ping", data);
    }
    function receiverOnPong(data) {
      this[kWebSocket].emit("pong", data);
    }
    function resume(stream) {
      stream.resume();
    }
    function senderOnError(err) {
      const websocket = this[kWebSocket];
      if (websocket.readyState === WebSocket2.CLOSED) return;
      if (websocket.readyState === WebSocket2.OPEN) {
        websocket._readyState = WebSocket2.CLOSING;
        setCloseTimer(websocket);
      }
      this._socket.end();
      if (!websocket._errorEmitted) {
        websocket._errorEmitted = true;
        websocket.emit("error", err);
      }
    }
    function setCloseTimer(websocket) {
      websocket._closeTimer = setTimeout(
        websocket._socket.destroy.bind(websocket._socket),
        websocket._closeTimeout
      );
    }
    function socketOnClose() {
      const websocket = this[kWebSocket];
      this.removeListener("close", socketOnClose);
      this.removeListener("data", socketOnData);
      this.removeListener("end", socketOnEnd);
      websocket._readyState = WebSocket2.CLOSING;
      if (!this._readableState.endEmitted && !websocket._closeFrameReceived && !websocket._receiver._writableState.errorEmitted && this._readableState.length !== 0) {
        const chunk = this.read(this._readableState.length);
        websocket._receiver.write(chunk);
      }
      websocket._receiver.end();
      this[kWebSocket] = void 0;
      clearTimeout(websocket._closeTimer);
      if (websocket._receiver._writableState.finished || websocket._receiver._writableState.errorEmitted) {
        websocket.emitClose();
      } else {
        websocket._receiver.on("error", receiverOnFinish);
        websocket._receiver.on("finish", receiverOnFinish);
      }
    }
    function socketOnData(chunk) {
      if (!this[kWebSocket]._receiver.write(chunk)) {
        this.pause();
      }
    }
    function socketOnEnd() {
      const websocket = this[kWebSocket];
      websocket._readyState = WebSocket2.CLOSING;
      websocket._receiver.end();
      this.end();
    }
    function socketOnError() {
      const websocket = this[kWebSocket];
      this.removeListener("error", socketOnError);
      this.on("error", NOOP);
      if (websocket) {
        websocket._readyState = WebSocket2.CLOSING;
        this.destroy();
      }
    }
  }
});

// ../node_modules/.pnpm/ws@8.20.0/node_modules/ws/lib/stream.js
var require_stream = __commonJS({
  "../node_modules/.pnpm/ws@8.20.0/node_modules/ws/lib/stream.js"(exports2, module2) {
    "use strict";
    var WebSocket2 = require_websocket();
    var { Duplex } = require("stream");
    function emitClose(stream) {
      stream.emit("close");
    }
    function duplexOnEnd() {
      if (!this.destroyed && this._writableState.finished) {
        this.destroy();
      }
    }
    function duplexOnError(err) {
      this.removeListener("error", duplexOnError);
      this.destroy();
      if (this.listenerCount("error") === 0) {
        this.emit("error", err);
      }
    }
    function createWebSocketStream2(ws, options) {
      let terminateOnDestroy = true;
      const duplex = new Duplex({
        ...options,
        autoDestroy: false,
        emitClose: false,
        objectMode: false,
        writableObjectMode: false
      });
      ws.on("message", function message(msg, isBinary) {
        const data = !isBinary && duplex._readableState.objectMode ? msg.toString() : msg;
        if (!duplex.push(data)) ws.pause();
      });
      ws.once("error", function error(err) {
        if (duplex.destroyed) return;
        terminateOnDestroy = false;
        duplex.destroy(err);
      });
      ws.once("close", function close() {
        if (duplex.destroyed) return;
        duplex.push(null);
      });
      duplex._destroy = function(err, callback) {
        if (ws.readyState === ws.CLOSED) {
          callback(err);
          process.nextTick(emitClose, duplex);
          return;
        }
        let called = false;
        ws.once("error", function error(err2) {
          called = true;
          callback(err2);
        });
        ws.once("close", function close() {
          if (!called) callback(err);
          process.nextTick(emitClose, duplex);
        });
        if (terminateOnDestroy) ws.terminate();
      };
      duplex._final = function(callback) {
        if (ws.readyState === ws.CONNECTING) {
          ws.once("open", function open() {
            duplex._final(callback);
          });
          return;
        }
        if (ws._socket === null) return;
        if (ws._socket._writableState.finished) {
          callback();
          if (duplex._readableState.endEmitted) duplex.destroy();
        } else {
          ws._socket.once("finish", function finish() {
            callback();
          });
          ws.close();
        }
      };
      duplex._read = function() {
        if (ws.isPaused) ws.resume();
      };
      duplex._write = function(chunk, encoding, callback) {
        if (ws.readyState === ws.CONNECTING) {
          ws.once("open", function open() {
            duplex._write(chunk, encoding, callback);
          });
          return;
        }
        ws.send(chunk, callback);
      };
      duplex.on("end", duplexOnEnd);
      duplex.on("error", duplexOnError);
      return duplex;
    }
    module2.exports = createWebSocketStream2;
  }
});

// ../node_modules/.pnpm/ws@8.20.0/node_modules/ws/lib/subprotocol.js
var require_subprotocol = __commonJS({
  "../node_modules/.pnpm/ws@8.20.0/node_modules/ws/lib/subprotocol.js"(exports2, module2) {
    "use strict";
    var { tokenChars } = require_validation();
    function parse(header) {
      const protocols = /* @__PURE__ */ new Set();
      let start = -1;
      let end = -1;
      let i = 0;
      for (i; i < header.length; i++) {
        const code = header.charCodeAt(i);
        if (end === -1 && tokenChars[code] === 1) {
          if (start === -1) start = i;
        } else if (i !== 0 && (code === 32 || code === 9)) {
          if (end === -1 && start !== -1) end = i;
        } else if (code === 44) {
          if (start === -1) {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
          if (end === -1) end = i;
          const protocol2 = header.slice(start, end);
          if (protocols.has(protocol2)) {
            throw new SyntaxError(`The "${protocol2}" subprotocol is duplicated`);
          }
          protocols.add(protocol2);
          start = end = -1;
        } else {
          throw new SyntaxError(`Unexpected character at index ${i}`);
        }
      }
      if (start === -1 || end !== -1) {
        throw new SyntaxError("Unexpected end of input");
      }
      const protocol = header.slice(start, i);
      if (protocols.has(protocol)) {
        throw new SyntaxError(`The "${protocol}" subprotocol is duplicated`);
      }
      protocols.add(protocol);
      return protocols;
    }
    module2.exports = { parse };
  }
});

// ../node_modules/.pnpm/ws@8.20.0/node_modules/ws/lib/websocket-server.js
var require_websocket_server = __commonJS({
  "../node_modules/.pnpm/ws@8.20.0/node_modules/ws/lib/websocket-server.js"(exports2, module2) {
    "use strict";
    var EventEmitter = require("events");
    var http = require("http");
    var { Duplex } = require("stream");
    var { createHash } = require("crypto");
    var extension2 = require_extension();
    var PerMessageDeflate2 = require_permessage_deflate();
    var subprotocol2 = require_subprotocol();
    var WebSocket2 = require_websocket();
    var { CLOSE_TIMEOUT, GUID, kWebSocket } = require_constants();
    var keyRegex = /^[+/0-9A-Za-z]{22}==$/;
    var RUNNING = 0;
    var CLOSING = 1;
    var CLOSED = 2;
    var WebSocketServer2 = class extends EventEmitter {
      /**
       * Create a `WebSocketServer` instance.
       *
       * @param {Object} options Configuration options
       * @param {Boolean} [options.allowSynchronousEvents=true] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {Boolean} [options.autoPong=true] Specifies whether or not to
       *     automatically send a pong in response to a ping
       * @param {Number} [options.backlog=511] The maximum length of the queue of
       *     pending connections
       * @param {Boolean} [options.clientTracking=true] Specifies whether or not to
       *     track clients
       * @param {Number} [options.closeTimeout=30000] Duration in milliseconds to
       *     wait for the closing handshake to finish after `websocket.close()` is
       *     called
       * @param {Function} [options.handleProtocols] A hook to handle protocols
       * @param {String} [options.host] The hostname where to bind the server
       * @param {Number} [options.maxPayload=104857600] The maximum allowed message
       *     size
       * @param {Boolean} [options.noServer=false] Enable no server mode
       * @param {String} [options.path] Accept only connections matching this path
       * @param {(Boolean|Object)} [options.perMessageDeflate=false] Enable/disable
       *     permessage-deflate
       * @param {Number} [options.port] The port where to bind the server
       * @param {(http.Server|https.Server)} [options.server] A pre-created HTTP/S
       *     server to use
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       * @param {Function} [options.verifyClient] A hook to reject connections
       * @param {Function} [options.WebSocket=WebSocket] Specifies the `WebSocket`
       *     class to use. It must be the `WebSocket` class or class that extends it
       * @param {Function} [callback] A listener for the `listening` event
       */
      constructor(options, callback) {
        super();
        options = {
          allowSynchronousEvents: true,
          autoPong: true,
          maxPayload: 100 * 1024 * 1024,
          skipUTF8Validation: false,
          perMessageDeflate: false,
          handleProtocols: null,
          clientTracking: true,
          closeTimeout: CLOSE_TIMEOUT,
          verifyClient: null,
          noServer: false,
          backlog: null,
          // use default (511 as implemented in net.js)
          server: null,
          host: null,
          path: null,
          port: null,
          WebSocket: WebSocket2,
          ...options
        };
        if (options.port == null && !options.server && !options.noServer || options.port != null && (options.server || options.noServer) || options.server && options.noServer) {
          throw new TypeError(
            'One and only one of the "port", "server", or "noServer" options must be specified'
          );
        }
        if (options.port != null) {
          this._server = http.createServer((req, res) => {
            const body = http.STATUS_CODES[426];
            res.writeHead(426, {
              "Content-Length": body.length,
              "Content-Type": "text/plain"
            });
            res.end(body);
          });
          this._server.listen(
            options.port,
            options.host,
            options.backlog,
            callback
          );
        } else if (options.server) {
          this._server = options.server;
        }
        if (this._server) {
          const emitConnection = this.emit.bind(this, "connection");
          this._removeListeners = addListeners(this._server, {
            listening: this.emit.bind(this, "listening"),
            error: this.emit.bind(this, "error"),
            upgrade: (req, socket, head) => {
              this.handleUpgrade(req, socket, head, emitConnection);
            }
          });
        }
        if (options.perMessageDeflate === true) options.perMessageDeflate = {};
        if (options.clientTracking) {
          this.clients = /* @__PURE__ */ new Set();
          this._shouldEmitClose = false;
        }
        this.options = options;
        this._state = RUNNING;
      }
      /**
       * Returns the bound address, the address family name, and port of the server
       * as reported by the operating system if listening on an IP socket.
       * If the server is listening on a pipe or UNIX domain socket, the name is
       * returned as a string.
       *
       * @return {(Object|String|null)} The address of the server
       * @public
       */
      address() {
        if (this.options.noServer) {
          throw new Error('The server is operating in "noServer" mode');
        }
        if (!this._server) return null;
        return this._server.address();
      }
      /**
       * Stop the server from accepting new connections and emit the `'close'` event
       * when all existing connections are closed.
       *
       * @param {Function} [cb] A one-time listener for the `'close'` event
       * @public
       */
      close(cb) {
        if (this._state === CLOSED) {
          if (cb) {
            this.once("close", () => {
              cb(new Error("The server is not running"));
            });
          }
          process.nextTick(emitClose, this);
          return;
        }
        if (cb) this.once("close", cb);
        if (this._state === CLOSING) return;
        this._state = CLOSING;
        if (this.options.noServer || this.options.server) {
          if (this._server) {
            this._removeListeners();
            this._removeListeners = this._server = null;
          }
          if (this.clients) {
            if (!this.clients.size) {
              process.nextTick(emitClose, this);
            } else {
              this._shouldEmitClose = true;
            }
          } else {
            process.nextTick(emitClose, this);
          }
        } else {
          const server2 = this._server;
          this._removeListeners();
          this._removeListeners = this._server = null;
          server2.close(() => {
            emitClose(this);
          });
        }
      }
      /**
       * See if a given request should be handled by this server instance.
       *
       * @param {http.IncomingMessage} req Request object to inspect
       * @return {Boolean} `true` if the request is valid, else `false`
       * @public
       */
      shouldHandle(req) {
        if (this.options.path) {
          const index = req.url.indexOf("?");
          const pathname = index !== -1 ? req.url.slice(0, index) : req.url;
          if (pathname !== this.options.path) return false;
        }
        return true;
      }
      /**
       * Handle a HTTP Upgrade request.
       *
       * @param {http.IncomingMessage} req The request object
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Function} cb Callback
       * @public
       */
      handleUpgrade(req, socket, head, cb) {
        socket.on("error", socketOnError);
        const key = req.headers["sec-websocket-key"];
        const upgrade = req.headers.upgrade;
        const version = +req.headers["sec-websocket-version"];
        if (req.method !== "GET") {
          const message = "Invalid HTTP method";
          abortHandshakeOrEmitwsClientError(this, req, socket, 405, message);
          return;
        }
        if (upgrade === void 0 || upgrade.toLowerCase() !== "websocket") {
          const message = "Invalid Upgrade header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
          return;
        }
        if (key === void 0 || !keyRegex.test(key)) {
          const message = "Missing or invalid Sec-WebSocket-Key header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
          return;
        }
        if (version !== 13 && version !== 8) {
          const message = "Missing or invalid Sec-WebSocket-Version header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message, {
            "Sec-WebSocket-Version": "13, 8"
          });
          return;
        }
        if (!this.shouldHandle(req)) {
          abortHandshake(socket, 400);
          return;
        }
        const secWebSocketProtocol = req.headers["sec-websocket-protocol"];
        let protocols = /* @__PURE__ */ new Set();
        if (secWebSocketProtocol !== void 0) {
          try {
            protocols = subprotocol2.parse(secWebSocketProtocol);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Protocol header";
            abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
            return;
          }
        }
        const secWebSocketExtensions = req.headers["sec-websocket-extensions"];
        const extensions = {};
        if (this.options.perMessageDeflate && secWebSocketExtensions !== void 0) {
          const perMessageDeflate = new PerMessageDeflate2({
            ...this.options.perMessageDeflate,
            isServer: true,
            maxPayload: this.options.maxPayload
          });
          try {
            const offers = extension2.parse(secWebSocketExtensions);
            if (offers[PerMessageDeflate2.extensionName]) {
              perMessageDeflate.accept(offers[PerMessageDeflate2.extensionName]);
              extensions[PerMessageDeflate2.extensionName] = perMessageDeflate;
            }
          } catch (err) {
            const message = "Invalid or unacceptable Sec-WebSocket-Extensions header";
            abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
            return;
          }
        }
        if (this.options.verifyClient) {
          const info = {
            origin: req.headers[`${version === 8 ? "sec-websocket-origin" : "origin"}`],
            secure: !!(req.socket.authorized || req.socket.encrypted),
            req
          };
          if (this.options.verifyClient.length === 2) {
            this.options.verifyClient(info, (verified, code, message, headers) => {
              if (!verified) {
                return abortHandshake(socket, code || 401, message, headers);
              }
              this.completeUpgrade(
                extensions,
                key,
                protocols,
                req,
                socket,
                head,
                cb
              );
            });
            return;
          }
          if (!this.options.verifyClient(info)) return abortHandshake(socket, 401);
        }
        this.completeUpgrade(extensions, key, protocols, req, socket, head, cb);
      }
      /**
       * Upgrade the connection to WebSocket.
       *
       * @param {Object} extensions The accepted extensions
       * @param {String} key The value of the `Sec-WebSocket-Key` header
       * @param {Set} protocols The subprotocols
       * @param {http.IncomingMessage} req The request object
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Function} cb Callback
       * @throws {Error} If called more than once with the same socket
       * @private
       */
      completeUpgrade(extensions, key, protocols, req, socket, head, cb) {
        if (!socket.readable || !socket.writable) return socket.destroy();
        if (socket[kWebSocket]) {
          throw new Error(
            "server.handleUpgrade() was called more than once with the same socket, possibly due to a misconfiguration"
          );
        }
        if (this._state > RUNNING) return abortHandshake(socket, 503);
        const digest = createHash("sha1").update(key + GUID).digest("base64");
        const headers = [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${digest}`
        ];
        const ws = new this.options.WebSocket(null, void 0, this.options);
        if (protocols.size) {
          const protocol = this.options.handleProtocols ? this.options.handleProtocols(protocols, req) : protocols.values().next().value;
          if (protocol) {
            headers.push(`Sec-WebSocket-Protocol: ${protocol}`);
            ws._protocol = protocol;
          }
        }
        if (extensions[PerMessageDeflate2.extensionName]) {
          const params = extensions[PerMessageDeflate2.extensionName].params;
          const value = extension2.format({
            [PerMessageDeflate2.extensionName]: [params]
          });
          headers.push(`Sec-WebSocket-Extensions: ${value}`);
          ws._extensions = extensions;
        }
        this.emit("headers", headers, req);
        socket.write(headers.concat("\r\n").join("\r\n"));
        socket.removeListener("error", socketOnError);
        ws.setSocket(socket, head, {
          allowSynchronousEvents: this.options.allowSynchronousEvents,
          maxPayload: this.options.maxPayload,
          skipUTF8Validation: this.options.skipUTF8Validation
        });
        if (this.clients) {
          this.clients.add(ws);
          ws.on("close", () => {
            this.clients.delete(ws);
            if (this._shouldEmitClose && !this.clients.size) {
              process.nextTick(emitClose, this);
            }
          });
        }
        cb(ws, req);
      }
    };
    module2.exports = WebSocketServer2;
    function addListeners(server2, map) {
      for (const event of Object.keys(map)) server2.on(event, map[event]);
      return function removeListeners() {
        for (const event of Object.keys(map)) {
          server2.removeListener(event, map[event]);
        }
      };
    }
    function emitClose(server2) {
      server2._state = CLOSED;
      server2.emit("close");
    }
    function socketOnError() {
      this.destroy();
    }
    function abortHandshake(socket, code, message, headers) {
      message = message || http.STATUS_CODES[code];
      headers = {
        Connection: "close",
        "Content-Type": "text/html",
        "Content-Length": Buffer.byteLength(message),
        ...headers
      };
      socket.once("finish", socket.destroy);
      socket.end(
        `HTTP/1.1 ${code} ${http.STATUS_CODES[code]}\r
` + Object.keys(headers).map((h) => `${h}: ${headers[h]}`).join("\r\n") + "\r\n\r\n" + message
      );
    }
    function abortHandshakeOrEmitwsClientError(server2, req, socket, code, message, headers) {
      if (server2.listenerCount("wsClientError")) {
        const err = new Error(message);
        Error.captureStackTrace(err, abortHandshakeOrEmitwsClientError);
        server2.emit("wsClientError", err, socket, req);
      } else {
        abortHandshake(socket, code, message, headers);
      }
    }
  }
});

// src/traversal-relay/server.ts
var import_http = require("http");
var import_fs2 = require("fs");
var import_os = require("os");
var import_path2 = require("path");

// ../node_modules/.pnpm/ws@8.20.0/node_modules/ws/wrapper.mjs
var import_stream = __toESM(require_stream(), 1);
var import_extension = __toESM(require_extension(), 1);
var import_permessage_deflate = __toESM(require_permessage_deflate(), 1);
var import_receiver = __toESM(require_receiver(), 1);
var import_sender = __toESM(require_sender(), 1);
var import_subprotocol = __toESM(require_subprotocol(), 1);
var import_websocket = __toESM(require_websocket(), 1);
var import_websocket_server = __toESM(require_websocket_server(), 1);

// src/traversal-relay/server.ts
var import_crypto2 = require("crypto");

// ../packages/shared/src/connection/relay-directory.ts
var RELAY_ENDPOINT_KINDS = /* @__PURE__ */ new Set([
  "lan",
  "rtc-direct",
  "tailscale",
  "ipv6",
  "ipv4",
  "relay-rtc"
]);
function requireControlObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}
function rejectUnknownFields(object, allowed, label) {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      throw new Error(`unknown ${label ? `${label} ` : ""}control field: ${key}`);
    }
  }
}
function validateEndpointCandidate(value) {
  const endpoint = requireControlObject(value, "endpoint candidate");
  rejectUnknownFields(
    endpoint,
    /* @__PURE__ */ new Set(["id", "kind", "host", "port", "wsUrl", "relayHostId", "authToken", "authRequired", "lastSeenAt"]),
    "endpoint"
  );
  if (typeof endpoint.id !== "string" || !endpoint.id.trim()) {
    throw new Error("endpoint candidate id is required");
  }
  if (typeof endpoint.kind !== "string" || !RELAY_ENDPOINT_KINDS.has(endpoint.kind)) {
    throw new Error(`unsupported endpoint candidate kind: ${String(endpoint.kind || "")}`);
  }
  if (typeof endpoint.authRequired !== "boolean") {
    throw new Error("endpoint candidate authRequired must be boolean");
  }
  if (typeof endpoint.lastSeenAt !== "string" || !endpoint.lastSeenAt.trim()) {
    throw new Error("endpoint candidate lastSeenAt is required");
  }
  for (const field of ["host", "wsUrl", "relayHostId", "authToken"]) {
    if (endpoint[field] !== void 0 && typeof endpoint[field] !== "string") {
      throw new Error(`endpoint candidate ${field} must be string`);
    }
  }
  if (endpoint.port !== void 0 && (typeof endpoint.port !== "number" || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535)) {
    throw new Error("endpoint candidate port is invalid");
  }
}
function validateSessionSnapshot(value) {
  const session = requireControlObject(value, "session snapshot");
  rejectUnknownFields(session, /* @__PURE__ */ new Set(["name", "cwd", "title", "updatedAt"]), "session");
  if (typeof session.name !== "string" || !session.name.trim()) {
    throw new Error("session snapshot name is required");
  }
  if (typeof session.updatedAt !== "string" || !session.updatedAt.trim()) {
    throw new Error("session snapshot updatedAt is required");
  }
  for (const field of ["cwd", "title"]) {
    if (session[field] !== void 0 && typeof session[field] !== "string") {
      throw new Error(`session snapshot ${field} must be string`);
    }
  }
}
function validateRelayDirectoryUpdatePayload(value) {
  const payload = requireControlObject(value, "relay directory update");
  rejectUnknownFields(payload, /* @__PURE__ */ new Set(["endpoints", "sessions", "publishedAt"]), "");
  if (payload.endpoints !== void 0) {
    if (!Array.isArray(payload.endpoints)) {
      throw new Error("relay directory endpoints must be an array");
    }
    payload.endpoints.forEach(validateEndpointCandidate);
  }
  if (payload.sessions !== void 0) {
    if (!Array.isArray(payload.sessions)) {
      throw new Error("relay directory sessions must be an array");
    }
    payload.sessions.forEach(validateSessionSnapshot);
  }
  if (payload.publishedAt !== void 0 && (typeof payload.publishedAt !== "string" || !payload.publishedAt.trim())) {
    throw new Error("relay directory publishedAt must be a non-empty string");
  }
  return true;
}
function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}
function asBoolean(value, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}
function asPositiveInteger(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : void 0;
}
function normalizeRelayEndpointCandidates(input, now) {
  if (!Array.isArray(input)) {
    return [];
  }
  const seen = /* @__PURE__ */ new Set();
  const endpoints = [];
  for (const item of input) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const candidate = item;
    if (candidate.kind !== "lan" && candidate.kind !== "rtc-direct" && candidate.kind !== "tailscale" && candidate.kind !== "ipv6" && candidate.kind !== "ipv4" && candidate.kind !== "relay-rtc") {
      continue;
    }
    const id = asString(candidate.id) || `${candidate.kind}:${asString(candidate.host) || asString(candidate.wsUrl) || asString(candidate.relayHostId)}`;
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    endpoints.push({
      id,
      kind: candidate.kind,
      ...asString(candidate.host) ? { host: asString(candidate.host) } : {},
      ...asPositiveInteger(candidate.port) ? { port: asPositiveInteger(candidate.port) } : {},
      ...asString(candidate.wsUrl) ? { wsUrl: asString(candidate.wsUrl) } : {},
      ...asString(candidate.relayHostId) ? { relayHostId: asString(candidate.relayHostId) } : {},
      ...asString(candidate.authToken) ? { authToken: asString(candidate.authToken) } : {},
      authRequired: asBoolean(candidate.authRequired, true),
      lastSeenAt: asString(candidate.lastSeenAt) || now
    });
  }
  return endpoints;
}
function normalizeRelayTmuxSessionSnapshots(input, now) {
  if (!Array.isArray(input)) {
    return [];
  }
  const seen = /* @__PURE__ */ new Set();
  const sessions = [];
  for (const item of input) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const candidate = item;
    const name = asString(candidate.name);
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    sessions.push({
      name,
      ...asString(candidate.cwd) ? { cwd: asString(candidate.cwd) } : {},
      ...asString(candidate.title) ? { title: asString(candidate.title) } : {},
      updatedAt: asString(candidate.updatedAt) || now
    });
  }
  return sessions;
}

// src/traversal-relay/client-debug-store.ts
var MAX_LOGS_PER_DEVICE = 500;
var MAX_LOG_QUERY_LIMIT = 500;
var TraversalRelayClientDebugStore = class {
  userDevices = /* @__PURE__ */ new Map();
  getDeviceState(userId, deviceId) {
    let devices = this.userDevices.get(userId);
    if (!devices) {
      devices = /* @__PURE__ */ new Map();
      this.userDevices.set(userId, devices);
    }
    let state = devices.get(deviceId);
    if (!state) {
      state = { logs: [], latestSnapshot: null };
      devices.set(deviceId, state);
    }
    return state;
  }
  appendLogs(userId, deviceId, entries) {
    const normalizedDeviceId = deviceId.trim();
    if (!userId.trim() || !normalizedDeviceId) {
      return;
    }
    const state = this.getDeviceState(userId, normalizedDeviceId);
    const ingestedAt = (/* @__PURE__ */ new Date()).toISOString();
    for (const entry of entries) {
      if (!entry || typeof entry.scope !== "string") {
        continue;
      }
      state.logs.push({
        deviceId: normalizedDeviceId,
        ingestedAt,
        seq: typeof entry.seq === "number" ? entry.seq : 0,
        ts: typeof entry.ts === "string" ? entry.ts : ingestedAt,
        scope: entry.scope,
        payload: typeof entry.payload === "string" ? entry.payload : void 0
      });
    }
    const overflow = state.logs.length - MAX_LOGS_PER_DEVICE;
    if (overflow > 0) {
      state.logs.splice(0, overflow);
    }
  }
  setSnapshot(userId, deviceId, snapshot) {
    const normalizedDeviceId = deviceId.trim();
    if (!userId.trim() || !normalizedDeviceId) {
      return;
    }
    const state = this.getDeviceState(userId, normalizedDeviceId);
    state.latestSnapshot = {
      deviceId: normalizedDeviceId,
      receivedAt: (/* @__PURE__ */ new Date()).toISOString(),
      requestId: snapshot.requestId?.trim() || void 0,
      reason: snapshot.reason?.trim() || void 0,
      snapshot: snapshot.snapshot
    };
  }
  getSnapshot(userId, deviceId) {
    return this.userDevices.get(userId)?.get(deviceId)?.latestSnapshot || null;
  }
  listLogs(userId, options) {
    const normalizedDeviceId = options.deviceId.trim();
    const state = this.userDevices.get(userId)?.get(normalizedDeviceId);
    if (!state) {
      return [];
    }
    const scopeIncludes = options.scopeIncludes?.trim().toLowerCase() || "";
    const filtered = scopeIncludes ? state.logs.filter((entry) => entry.scope.toLowerCase().includes(scopeIncludes)) : state.logs;
    const limit = Math.max(1, Math.min(MAX_LOG_QUERY_LIMIT, Math.floor(options.limit || 200)));
    return filtered.slice(Math.max(0, filtered.length - limit)).reverse();
  }
  listDeviceSummaries(userId) {
    const devices = this.userDevices.get(userId);
    if (!devices) {
      return [];
    }
    return Array.from(devices.entries()).map(([deviceId, state]) => {
      const latestLog = state.logs[state.logs.length - 1] || null;
      return {
        deviceId,
        logCount: state.logs.length,
        latestLogScope: latestLog?.scope || null,
        latestLogTs: latestLog?.ts || null,
        latestSnapshotAt: state.latestSnapshot?.receivedAt || null,
        latestSnapshotRequestId: state.latestSnapshot?.requestId || null
      };
    }).sort((a, b) => {
      const aKey = a.latestSnapshotAt || a.latestLogTs || "";
      const bKey = b.latestSnapshotAt || b.latestLogTs || "";
      return bKey.localeCompare(aKey);
    });
  }
};

// src/traversal-relay/store.ts
var import_fs = require("fs");
var import_path = require("path");
var import_crypto = require("crypto");
function createEmptyStore() {
  return {
    users: [],
    tokens: [],
    devices: []
  };
}
function ensureStoreDir(path) {
  (0, import_fs.mkdirSync)((0, import_path.dirname)(path), { recursive: true });
}
function stableNow() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function randomHex(bytes = 16) {
  return (0, import_crypto.randomBytes)(bytes).toString("hex");
}
function hashPassword(password, salt) {
  return (0, import_crypto.scryptSync)(password, salt, 64).toString("hex");
}
function normalizeUsername(value) {
  return value.trim().toLowerCase();
}
function normalizeDeviceId(value) {
  return value.trim();
}
function asStoredDevice(record) {
  const userId = typeof record.userId === "string" ? record.userId.trim() : "";
  const deviceId = typeof record.deviceId === "string" ? normalizeDeviceId(record.deviceId) : "";
  if (!userId || !deviceId) {
    return null;
  }
  const createdAt = typeof record.createdAt === "string" && record.createdAt.trim() ? record.createdAt : stableNow();
  const updatedAt = typeof record.updatedAt === "string" && record.updatedAt.trim() ? record.updatedAt : createdAt;
  const lastSeenAt = typeof record.lastSeenAt === "string" && record.lastSeenAt.trim() ? record.lastSeenAt : updatedAt;
  const clientLastSeenAt = typeof record.clientLastSeenAt === "string" ? record.clientLastSeenAt : "";
  const daemonLastSeenAt = typeof record.daemonLastSeenAt === "string" ? record.daemonLastSeenAt : "";
  return {
    userId,
    deviceId,
    deviceName: typeof record.deviceName === "string" ? record.deviceName.trim() : "",
    platform: typeof record.platform === "string" ? record.platform.trim() : "",
    appVersion: typeof record.appVersion === "string" ? record.appVersion.trim() : "",
    createdAt,
    updatedAt,
    lastSeenAt,
    clientConnected: false,
    clientLastSeenAt,
    daemonConnected: false,
    daemonLastSeenAt,
    daemonHostId: typeof record.daemonHostId === "string" ? record.daemonHostId.trim() : "",
    daemonVersion: typeof record.daemonVersion === "string" ? record.daemonVersion.trim() : "",
    daemonDirectoryPublishedAt: typeof record.daemonDirectoryPublishedAt === "string" ? record.daemonDirectoryPublishedAt : "",
    daemonEndpoints: normalizeRelayEndpointCandidates(record.daemonEndpoints, updatedAt),
    daemonSessions: normalizeRelayTmuxSessionSnapshots(record.daemonSessions, updatedAt)
  };
}
function toPublicUser(user) {
  return {
    id: user.id,
    username: user.username,
    createdAt: user.createdAt
  };
}
function toDeviceSnapshot(record) {
  return {
    deviceId: record.deviceId,
    deviceName: record.deviceName,
    platform: record.platform,
    appVersion: record.appVersion,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastSeenAt: record.lastSeenAt,
    online: record.clientConnected || record.daemonConnected,
    client: {
      connected: record.clientConnected,
      lastSeenAt: record.clientLastSeenAt
    },
    daemon: {
      connected: record.daemonConnected,
      lastSeenAt: record.daemonLastSeenAt,
      hostId: record.daemonHostId,
      version: record.daemonVersion
    }
  };
}
function toDirectoryDevice(record) {
  const daemon = record.daemonHostId ? {
    hostId: record.daemonHostId,
    version: record.daemonVersion,
    presence: {
      connected: record.daemonConnected,
      lastSeenAt: record.daemonLastSeenAt
    },
    endpoints: record.daemonEndpoints,
    sessions: record.daemonSessions,
    lastPublishedAt: record.daemonDirectoryPublishedAt || record.daemonLastSeenAt
  } : null;
  return {
    deviceId: record.deviceId,
    deviceName: record.deviceName,
    platform: record.platform,
    appVersion: record.appVersion,
    client: {
      connected: record.clientConnected,
      lastSeenAt: record.clientLastSeenAt
    },
    daemon
  };
}
var TraversalRelayStore = class {
  constructor(path) {
    this.path = path;
    this.data = this.load();
  }
  path;
  data;
  load() {
    if (!(0, import_fs.existsSync)(this.path)) {
      return createEmptyStore();
    }
    const raw = (0, import_fs.readFileSync)(this.path, "utf-8");
    if (!raw.trim()) {
      return createEmptyStore();
    }
    const parsed = JSON.parse(raw);
    return {
      users: Array.isArray(parsed.users) ? parsed.users : [],
      tokens: Array.isArray(parsed.tokens) ? parsed.tokens : [],
      devices: Array.isArray(parsed.devices) ? parsed.devices.map((entry) => asStoredDevice(entry)).filter((entry) => entry !== null) : []
    };
  }
  persist() {
    ensureStoreDir(this.path);
    const tempPath = `${this.path}.tmp`;
    (0, import_fs.writeFileSync)(tempPath, JSON.stringify(this.data, null, 2));
    (0, import_fs.renameSync)(tempPath, this.path);
  }
  requireUserById(userId) {
    const user = this.data.users.find((entry) => entry.id === userId);
    if (!user) {
      throw new Error(`user ${userId} not found`);
    }
    return user;
  }
  getOrCreateDevice(userId, deviceId) {
    const normalizedDeviceId = normalizeDeviceId(deviceId);
    if (!normalizedDeviceId) {
      throw new Error("deviceId is required");
    }
    let device = this.data.devices.find((entry) => entry.userId === userId && entry.deviceId === normalizedDeviceId);
    if (device) {
      return device;
    }
    const now = stableNow();
    device = {
      userId,
      deviceId: normalizedDeviceId,
      deviceName: "",
      platform: "",
      appVersion: "",
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
      clientConnected: false,
      clientLastSeenAt: "",
      daemonConnected: false,
      daemonLastSeenAt: "",
      daemonHostId: "",
      daemonVersion: "",
      daemonDirectoryPublishedAt: "",
      daemonEndpoints: [],
      daemonSessions: []
    };
    this.data.devices.push(device);
    return device;
  }
  patchDeviceIdentity(device, input) {
    const nextDeviceName = typeof input.deviceName === "string" ? input.deviceName.trim() : "";
    const nextPlatform = typeof input.platform === "string" ? input.platform.trim() : "";
    const nextAppVersion = typeof input.appVersion === "string" ? input.appVersion.trim() : "";
    if (nextDeviceName) {
      device.deviceName = nextDeviceName;
    }
    if (nextPlatform) {
      device.platform = nextPlatform;
    }
    if (nextAppVersion) {
      device.appVersion = nextAppVersion;
    }
  }
  register(username, password) {
    const normalizedUsername = normalizeUsername(username);
    if (!normalizedUsername) {
      throw new Error("username is required");
    }
    if (!password.trim()) {
      throw new Error("password is required");
    }
    if (this.data.users.some((user) => user.username === normalizedUsername)) {
      throw new Error("username already exists");
    }
    const salt = randomHex(16);
    const now = stableNow();
    const record = {
      id: randomHex(16),
      username: normalizedUsername,
      passwordSalt: salt,
      passwordHash: hashPassword(password, salt),
      createdAt: now
    };
    this.data.users.push(record);
    this.persist();
    return toPublicUser(record);
  }
  login(username, password) {
    const normalizedUsername = normalizeUsername(username);
    const user = this.data.users.find((entry) => entry.username === normalizedUsername);
    if (!user) {
      throw new Error("invalid username or password");
    }
    const expected = Buffer.from(user.passwordHash, "hex");
    const actual = Buffer.from(hashPassword(password, user.passwordSalt), "hex");
    if (expected.length !== actual.length || !(0, import_crypto.timingSafeEqual)(expected, actual)) {
      throw new Error("invalid username or password");
    }
    const now = stableNow();
    const tokenRecord = {
      token: randomHex(24),
      userId: user.id,
      createdAt: now,
      lastUsedAt: now
    };
    this.data.tokens.push(tokenRecord);
    this.persist();
    return {
      token: tokenRecord.token,
      user: toPublicUser(user)
    };
  }
  authenticate(token) {
    const record = this.data.tokens.find((entry) => entry.token === token.trim());
    if (!record) {
      return null;
    }
    const user = this.data.users.find((entry) => entry.id === record.userId);
    if (!user) {
      return null;
    }
    record.lastUsedAt = stableNow();
    this.persist();
    return toPublicUser(user);
  }
  setClientConnected(options) {
    this.requireUserById(options.userId);
    const device = this.getOrCreateDevice(options.userId, options.deviceId);
    this.patchDeviceIdentity(device, options);
    const now = stableNow();
    device.clientConnected = options.connected;
    device.updatedAt = now;
    device.lastSeenAt = now;
    device.clientLastSeenAt = now;
    this.persist();
    return toDeviceSnapshot(device);
  }
  publishDaemonDirectory(options) {
    this.requireUserById(options.userId);
    const hostId = options.hostId.trim();
    if (!hostId) {
      throw new Error("hostId is required");
    }
    const device = this.getOrCreateDevice(options.userId, options.deviceId);
    this.patchDeviceIdentity(device, options);
    const now = stableNow();
    const publishedAt = options.publishedAt?.trim() || now;
    device.daemonConnected = true;
    device.daemonHostId = hostId;
    device.daemonLastSeenAt = now;
    device.daemonDirectoryPublishedAt = publishedAt;
    device.updatedAt = now;
    device.lastSeenAt = now;
    if (typeof options.daemonVersion === "string" && options.daemonVersion.trim()) {
      device.daemonVersion = options.daemonVersion.trim();
    }
    device.daemonEndpoints = normalizeRelayEndpointCandidates(options.endpoints, publishedAt);
    device.daemonSessions = normalizeRelayTmuxSessionSnapshots(options.sessions, publishedAt);
    this.persist();
    return toDirectoryDevice(device);
  }
  setDaemonConnected(options) {
    this.requireUserById(options.userId);
    const hostId = options.hostId.trim();
    if (!hostId) {
      throw new Error("hostId is required");
    }
    const device = this.getOrCreateDevice(options.userId, options.deviceId);
    this.patchDeviceIdentity(device, options);
    const now = stableNow();
    device.daemonConnected = options.connected;
    device.daemonHostId = hostId;
    device.daemonLastSeenAt = now;
    device.updatedAt = now;
    device.lastSeenAt = now;
    if (typeof options.daemonVersion === "string" && options.daemonVersion.trim()) {
      device.daemonVersion = options.daemonVersion.trim();
    }
    this.persist();
    return toDeviceSnapshot(device);
  }
  listDevices(userId) {
    this.requireUserById(userId);
    return this.data.devices.filter((entry) => entry.userId === userId).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.deviceId.localeCompare(right.deviceId)).map((entry) => toDeviceSnapshot(entry));
  }
  getAccountDirectory(userId) {
    const user = this.requireUserById(userId);
    const devices = this.data.devices.filter((entry) => entry.userId === userId).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.deviceId.localeCompare(right.deviceId)).map((entry) => toDirectoryDevice(entry));
    return {
      schemaVersion: 1,
      user: {
        id: user.id,
        username: user.username
      },
      devices,
      updatedAt: stableNow()
    };
  }
  summary() {
    return {
      users: this.data.users.length,
      tokens: this.data.tokens.length,
      devices: this.data.devices.length
    };
  }
};

// src/traversal-relay/server.ts
function asString2(value) {
  return typeof value === "string" ? value.trim() : "";
}
function resolvePort() {
  const raw = asString2(process.env.ZTERM_TRAVERSAL_PORT || process.env.PORT || "19090");
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 19090;
}
function resolveHost() {
  return asString2(process.env.ZTERM_TRAVERSAL_HOST || process.env.HOST || "127.0.0.1") || "127.0.0.1";
}
function resolveStorePath() {
  const configured = asString2(process.env.ZTERM_TRAVERSAL_STORE_PATH);
  if (configured) {
    return configured;
  }
  const baseDir = asString2(process.env.ZTERM_TRAVERSAL_DATA_DIR) || (0, import_path2.join)((0, import_os.homedir)(), ".zterm", "traversal-relay");
  return (0, import_path2.join)(baseDir, "store.json");
}
function resolveUpdatesDir(storePath) {
  const configured = asString2(process.env.ZTERM_TRAVERSAL_UPDATES_DIR || process.env.ZTERM_RELAY_UPDATES_DIR);
  if (configured) {
    return (0, import_path2.resolve)(configured);
  }
  return (0, import_path2.join)((0, import_path2.dirname)(storePath), "updates");
}
function resolveBasePath() {
  const raw = asString2(process.env.ZTERM_TRAVERSAL_BASE_PATH);
  if (!raw || raw === "/") {
    return "";
  }
  const withLeadingSlash = raw.startsWith("/") ? raw : `/${raw}`;
  return withLeadingSlash.replace(/\/+$/, "");
}
function resolveTurnConfig() {
  const url = asString2(process.env.ZTERM_TURN_URL);
  const username = asString2(process.env.ZTERM_TURN_USERNAME);
  const credential = asString2(process.env.ZTERM_TURN_CREDENTIAL);
  if (!url) {
    return null;
  }
  return { url, username, credential };
}
function resolveRequestOrigin(request) {
  const protocol = request.headers["x-forwarded-proto"]?.split(",")[0]?.trim() || "http";
  const host = request.headers["x-forwarded-host"] || request.headers.host || `${HOST}:${PORT}`;
  return `${protocol}://${host}`;
}
function routePath(path) {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${BASE_PATH}${normalized}` || normalized;
}
function buildPublicBaseUrl(request) {
  return `${resolveRequestOrigin(request)}${BASE_PATH}/`;
}
function buildWebSocketBaseUrl(request) {
  const httpOrigin = resolveRequestOrigin(request);
  const wsOrigin = httpOrigin.startsWith("https://") ? `wss://${httpOrigin.slice("https://".length)}` : httpOrigin.startsWith("http://") ? `ws://${httpOrigin.slice("http://".length)}` : httpOrigin;
  return `${wsOrigin}${BASE_PATH}/`;
}
function writeCorsHeaders(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  response.setHeader("Access-Control-Allow-Methods", "GET,HEAD,POST,OPTIONS");
}
function serveJson(response, payload, statusCode = 200, options = {}) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(options.omitBody ? void 0 : JSON.stringify(payload));
}
function serveHtml(response, html, statusCode = 200) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(html);
}
async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  return raw.trim() ? JSON.parse(raw) : {};
}
function extractAccessToken(request, url) {
  const authHeader = asString2(request.headers.authorization);
  if (authHeader.toLowerCase().startsWith("bearer ")) {
    return authHeader.slice(7).trim();
  }
  return asString2(url.searchParams.get("token") || url.searchParams.get("accessToken"));
}
function sendHostEnvelope(socket, envelope) {
  if (socket.readyState !== import_websocket.default.OPEN) {
    return;
  }
  socket.send(JSON.stringify(envelope));
}
function sendDeviceEnvelope(socket, envelope) {
  if (socket.readyState !== import_websocket.default.OPEN) {
    return;
  }
  socket.send(JSON.stringify(envelope));
}
function hostKey(userId, hostId) {
  return `${userId}:${hostId}`;
}
function deviceKey(userId, deviceId) {
  return `${userId}:${deviceId}`;
}
function clientPeerLeaseKey(userId, hostId, deviceId) {
  const normalizedDeviceId = asString2(deviceId);
  if (!normalizedDeviceId) {
    return null;
  }
  return `${userId}:${hostId}:${normalizedDeviceId}`;
}
function buildAuthPage(mode) {
  const pageTitle = mode === "login" ? "ZTerm Relay Login" : "ZTerm Relay Register";
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${pageTitle}</title>
    <style>
      :root { color-scheme: dark; }
      body { margin:0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:#0b1220; color:#e5eefb; }
      .wrap { max-width: 980px; margin: 0 auto; padding: 32px 18px 56px; }
      .hero { display:flex; justify-content:space-between; gap:16px; flex-wrap:wrap; align-items:flex-start; margin-bottom: 24px; }
      .hero h1 { margin:0; font-size:28px; }
      .hero p { margin:8px 0 0; color:#93a4bf; line-height:1.6; }
      .tabs { display:flex; gap:8px; margin-top: 10px; }
      .tab { padding:10px 14px; border-radius: 10px; background:#162033; color:#dce8fb; text-decoration:none; }
      .tab.active { background:#2c486d; }
      .grid { display:grid; grid-template-columns: minmax(300px, 380px) 1fr; gap:18px; }
      .card { background:#111a2d; border:1px solid #1d2a45; border-radius:16px; padding:18px; box-shadow:0 16px 40px rgba(0,0,0,.25); }
      label { display:block; font-size:13px; color:#9fb2d1; margin-bottom:8px; }
      input { width:100%; box-sizing:border-box; padding:12px 14px; border-radius:12px; border:1px solid #2a3a5c; background:#0b1322; color:#f3f7ff; margin-bottom:12px; }
      button { width:100%; padding:12px 14px; border:none; border-radius:12px; background:#4b81c7; color:white; font-weight:700; cursor:pointer; }
      button.secondary { background:#26354f; }
      .stack { display:flex; flex-direction:column; gap:12px; }
      .hint { font-size:12px; color:#8da0bd; line-height:1.6; }
      .status { padding:10px 12px; border-radius:12px; background:#0b1322; color:#b9c7de; white-space:pre-wrap; word-break:break-word; min-height:44px; }
      .device-list { display:flex; flex-direction:column; gap:10px; margin-top:12px; }
      .device { background:#0b1322; border:1px solid #223152; border-radius:12px; padding:12px; }
      .device h3 { margin:0 0 8px; font-size:15px; }
      .meta { display:grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap:6px 12px; font-size:12px; color:#9fb2d1; }
      code { color:#cfe0ff; }
      @media (max-width: 860px) { .grid { grid-template-columns: 1fr; } }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="hero">
        <div>
          <h1>${pageTitle}</h1>
          <p>\u8FD9\u662F zterm traversal/turn \u63A7\u5236\u9762\u3002\u4E3B\u767B\u5F55\u901A\u5E38\u7531\u5BA2\u6237\u7AEF\u5B8C\u6210\uFF1B\u6B64\u9875\u9762\u7528\u4E8E\u6CE8\u518C\u3001\u767B\u5F55\u4E0E\u5B9E\u65F6\u67E5\u770B\u5F53\u524D\u7528\u6237\u540D\u4E0B\u8BBE\u5907\u7ED1\u5B9A\u72B6\u6001\u3002</p>
        </div>
        <div class="tabs">
          <a class="tab ${mode === "login" ? "active" : ""}" href="${routePath("/login")}">\u767B\u5F55</a>
          <a class="tab ${mode === "register" ? "active" : ""}" href="${routePath("/register")}">\u6CE8\u518C</a>
        </div>
      </div>

      <div class="grid">
        <div class="card">
          <div class="stack">
            <div>
              <label>\u7528\u6237\u540D</label>
              <input id="username" autocomplete="username" />
            </div>
            <div>
              <label>\u5BC6\u7801</label>
              <input id="password" type="password" autocomplete="current-password" />
            </div>
            <div>
              <label>\u8BBE\u5907 ID\uFF08\u7528\u4E8E\u5B9E\u65F6 presence\uFF0C\u53EF\u7559\u7A7A\u53EA\u67E5\u770B\uFF09</label>
              <input id="deviceId" placeholder="\u4F8B\u5982 tablet-jason / macbook-jason" />
            </div>
            <div>
              <label>\u8BBE\u5907\u540D\u79F0</label>
              <input id="deviceName" placeholder="\u4F8B\u5982 Jason iPad" />
            </div>
            <div>
              <label>\u5E73\u53F0</label>
              <input id="platform" placeholder="android / ios / mac / windows" />
            </div>
            <div>
              <label>App Version</label>
              <input id="appVersion" placeholder="0.1.1" />
            </div>
            ${mode === "register" ? '<button id="submit">\u6CE8\u518C\u5E76\u767B\u5F55</button>' : '<button id="submit">\u767B\u5F55</button>'}
            <button class="secondary" id="connectDevices">\u8FDE\u63A5\u8BBE\u5907\u5217\u8868\u6D41</button>
            <div class="hint">API base: <code>${BASE_PATH || "/"}</code><br/>\u767B\u5F55\u540E\u4F1A\u901A\u8FC7 <code>/ws/devices</code> \u5B9E\u65F6\u63A8\u9001\u540C\u7528\u6237\u540D\u4E0B\u8BBE\u5907\u5217\u8868\u3002</div>
            <div id="status" class="status">\u5C1A\u672A\u767B\u5F55</div>
          </div>
        </div>

        <div class="card">
          <h2 style="margin-top:0; font-size:18px;">\u8BBE\u5907\u5217\u8868</h2>
          <div class="hint">client \u767B\u5F55\u540E\u4F1A\u5B9E\u65F6\u4E0A\u62A5 device presence\uFF1Bdaemon \u8FDE\u63A5\u65F6\u4F1A\u7ED1\u5B9A deviceId + hostId\u3002</div>
          <div id="userInfo" class="status" style="margin-top:12px;">\u672A\u8FDE\u63A5</div>
          <div id="devices" class="device-list"></div>
        </div>
      </div>
    </div>

    <script>
      const mode = ${JSON.stringify(mode)};
      const basePath = ${JSON.stringify(BASE_PATH)};
      const tokenKey = 'ztermRelayAccessToken';
      const userKey = 'ztermRelayUser';
      const els = {
        username: document.getElementById('username'),
        password: document.getElementById('password'),
        deviceId: document.getElementById('deviceId'),
        deviceName: document.getElementById('deviceName'),
        platform: document.getElementById('platform'),
        appVersion: document.getElementById('appVersion'),
        submit: document.getElementById('submit'),
        connectDevices: document.getElementById('connectDevices'),
        status: document.getElementById('status'),
        userInfo: document.getElementById('userInfo'),
        devices: document.getElementById('devices'),
      };
      let accessToken = localStorage.getItem(tokenKey) || '';
      let deviceSocket = null;
      const cachedUserRaw = localStorage.getItem(userKey);
      if (cachedUserRaw) {
        try {
          const cachedUser = JSON.parse(cachedUserRaw);
          els.userInfo.textContent = JSON.stringify(cachedUser, null, 2);
          if (cachedUser.username) {
            els.username.value = cachedUser.username;
          }
        } catch {}
      }

      function endpoint(path) {
        return (basePath || '') + path;
      }

      function setStatus(text) {
        els.status.textContent = text;
      }

      function saveAuth(payload) {
        accessToken = payload.accessToken || '';
        localStorage.setItem(tokenKey, accessToken);
        localStorage.setItem(userKey, JSON.stringify(payload.user || null));
        els.userInfo.textContent = JSON.stringify(payload.user || null, null, 2);
      }

      function renderDevices(devices) {
        els.devices.innerHTML = '';
        if (!devices || devices.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'device';
          empty.textContent = '\u5F53\u524D\u6CA1\u6709\u8BBE\u5907';
          els.devices.appendChild(empty);
          return;
        }
        for (const device of devices) {
          const item = document.createElement('div');
          item.className = 'device';
          const title = document.createElement('h3');
          title.textContent = (device.deviceName || '(\u672A\u547D\u540D\u8BBE\u5907)') + ' \xB7 ' + device.deviceId;
          const meta = document.createElement('div');
          meta.className = 'meta';
          const rows = [
            ['platform', device.platform || '-'],
            ['appVersion', device.appVersion || '-'],
            ['online', String(Boolean(device.online))],
            ['client', device.client?.connected ? 'connected' : 'offline'],
            ['daemon', device.daemon?.connected ? ('connected (' + (device.daemon?.hostId || '-') + ')') : 'offline'],
            ['daemonVersion', device.daemon?.version || '-'],
            ['updatedAt', device.updatedAt || '-'],
            ['lastSeenAt', device.lastSeenAt || '-'],
          ];
          for (const [key, value] of rows) {
            const row = document.createElement('div');
            row.innerHTML = '<strong>' + key + '</strong>: ' + value;
            meta.appendChild(row);
          }
          item.appendChild(title);
          item.appendChild(meta);
          els.devices.appendChild(item);
        }
      }

      async function authRequest(path, payload) {
        const response = await fetch(endpoint(path), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await response.json();
        if (!response.ok || !data.ok) {
          throw new Error(data.message || ('HTTP ' + response.status));
        }
        return data;
      }

      async function fetchDevices() {
        if (!accessToken) {
          throw new Error('\u8BF7\u5148\u767B\u5F55');
        }
        const response = await fetch(endpoint('/api/devices'), {
          headers: { authorization: 'Bearer ' + accessToken },
        });
        const data = await response.json();
        if (!response.ok || !data.ok) {
          throw new Error(data.message || ('HTTP ' + response.status));
        }
        renderDevices(data.devices || []);
      }

      function connectDevicesSocket() {
        if (!accessToken) {
          setStatus('\u8BF7\u5148\u767B\u5F55');
          return;
        }
        if (deviceSocket && deviceSocket.readyState < 2) {
          setStatus('\u8BBE\u5907\u6D41\u5DF2\u8FDE\u63A5');
          return;
        }
        const url = new URL(((location.protocol === 'https:') ? 'wss://' : 'ws://') + location.host + endpoint('/ws/devices'));
        url.searchParams.set('token', accessToken);
        if (els.deviceId.value.trim()) url.searchParams.set('deviceId', els.deviceId.value.trim());
        if (els.deviceName.value.trim()) url.searchParams.set('deviceName', els.deviceName.value.trim());
        if (els.platform.value.trim()) url.searchParams.set('platform', els.platform.value.trim());
        if (els.appVersion.value.trim()) url.searchParams.set('appVersion', els.appVersion.value.trim());
        deviceSocket = new WebSocket(url);
        deviceSocket.onopen = () => {
          setStatus('\u8BBE\u5907\u6D41\u5DF2\u8FDE\u63A5');
          deviceSocket.send(JSON.stringify({
            type: 'devices-request',
            payload: {
              deviceId: els.deviceId.value.trim(),
              deviceName: els.deviceName.value.trim(),
              platform: els.platform.value.trim(),
              appVersion: els.appVersion.value.trim(),
            },
          }));
        };
        deviceSocket.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data.type === 'devices-snapshot' || data.type === 'device-updated') {
              renderDevices(data.payload?.devices || []);
              return;
            }
            if (data.type === 'relay-error') {
              setStatus(data.reason || '\u8BBE\u5907\u6D41\u9519\u8BEF');
            }
          } catch (error) {
            setStatus('\u8BBE\u5907\u6D41\u6D88\u606F\u89E3\u6790\u5931\u8D25: ' + error.message);
          }
        };
        deviceSocket.onerror = () => setStatus('\u8BBE\u5907\u6D41\u8FDE\u63A5\u5931\u8D25');
        deviceSocket.onclose = () => setStatus('\u8BBE\u5907\u6D41\u5DF2\u5173\u95ED');
      }

      els.submit.onclick = async () => {
        try {
          setStatus(mode === 'register' ? '\u6CE8\u518C\u4E2D\u2026' : '\u767B\u5F55\u4E2D\u2026');
          if (mode === 'register') {
            await authRequest('/api/auth/register', {
              username: els.username.value,
              password: els.password.value,
            });
          }
          const login = await authRequest('/api/auth/login', {
            username: els.username.value,
            password: els.password.value,
          });
          saveAuth(login);
          setStatus('\u767B\u5F55\u6210\u529F');
          renderDevices(login.devices || []);
          connectDevicesSocket();
        } catch (error) {
          setStatus(error.message || String(error));
        }
      };

      els.connectDevices.onclick = async () => {
        try {
          await fetchDevices();
          connectDevicesSocket();
        } catch (error) {
          setStatus(error.message || String(error));
        }
      };
    </script>
  </body>
</html>`;
}
var PORT = resolvePort();
var HOST = resolveHost();
var STORE_PATH = resolveStorePath();
var UPDATES_DIR = resolveUpdatesDir(STORE_PATH);
var BASE_PATH = resolveBasePath();
var TURN_CONFIG = resolveTurnConfig();
var RELAY_CLIENT_PEER_IDLE_TIMEOUT_MS = 30 * 60 * 1e3;
(0, import_fs2.mkdirSync)((0, import_path2.dirname)(STORE_PATH), { recursive: true });
(0, import_fs2.mkdirSync)(UPDATES_DIR, { recursive: true });
var store = new TraversalRelayStore(STORE_PATH);
var hosts = /* @__PURE__ */ new Map();
var clients = /* @__PURE__ */ new Map();
var idleClients = /* @__PURE__ */ new Map();
var deviceStreams = /* @__PURE__ */ new Map();
var liveClientDevices = /* @__PURE__ */ new Map();
var liveDaemonDevices = /* @__PURE__ */ new Map();
var clientDebugStore = new TraversalRelayClientDebugStore();
function addLivePresence(map, connectionId, userId, deviceId) {
  const key = deviceKey(userId, deviceId);
  const current = map.get(key) || /* @__PURE__ */ new Set();
  current.add(connectionId);
  map.set(key, current);
}
function removeLivePresence(map, connectionId, userId, deviceId) {
  const key = deviceKey(userId, deviceId);
  const current = map.get(key);
  if (!current) {
    return false;
  }
  current.delete(connectionId);
  if (current.size === 0) {
    map.delete(key);
    return false;
  }
  return true;
}
function buildHealthSnapshot(request) {
  return {
    ok: true,
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    pid: process.pid,
    origin: resolveRequestOrigin(request),
    basePath: BASE_PATH || "/",
    listeners: {
      host: HOST,
      port: PORT
    },
    store: store.summary(),
    updates: {
      dir: UPDATES_DIR,
      manifestPresent: (0, import_fs2.existsSync)((0, import_path2.join)(UPDATES_DIR, "latest.json"))
    },
    relay: {
      hosts: hosts.size,
      clients: clients.size,
      deviceStreams: deviceStreams.size,
      liveClientDevices: liveClientDevices.size,
      liveDaemonDevices: liveDaemonDevices.size
    },
    turn: buildHealthTurnSnapshot()
  };
}
function resolveUpdateFilePath(pathname) {
  const updatesPrefix = routePath("/updates/");
  if (!pathname.startsWith(updatesPrefix)) {
    return null;
  }
  const relativePath = pathname.slice(updatesPrefix.length);
  const safeName = (0, import_path2.basename)(relativePath);
  const updatesRoot = (0, import_path2.resolve)(UPDATES_DIR);
  const absolutePath = (0, import_path2.resolve)(updatesRoot, safeName);
  if (absolutePath !== updatesRoot && !absolutePath.startsWith(`${updatesRoot}/`)) {
    return null;
  }
  return absolutePath;
}
function isGetOrHead(request) {
  return request.method === "GET" || request.method === "HEAD";
}
function buildHealthTurnSnapshot() {
  if (!TURN_CONFIG) {
    return null;
  }
  return {
    configured: true,
    url: TURN_CONFIG.url,
    username: TURN_CONFIG.username ? "configured" : "",
    credential: TURN_CONFIG.credential ? "configured" : ""
  };
}
function buildAuthPayload(request, user, accessToken) {
  return {
    ok: true,
    accessToken,
    user,
    devices: store.listDevices(user.id),
    directory: store.getAccountDirectory(user.id),
    turn: TURN_CONFIG,
    relayBaseUrl: buildPublicBaseUrl(request),
    signalBaseUrl: buildPublicBaseUrl(request),
    ws: {
      devices: `${buildWebSocketBaseUrl(request)}ws/devices`,
      host: `${buildWebSocketBaseUrl(request)}ws/host`,
      client: `${buildWebSocketBaseUrl(request)}ws/client`
    }
  };
}
function broadcastDevices(userId) {
  const devices = store.listDevices(userId);
  const directory = store.getAccountDirectory(userId);
  for (const connection of deviceStreams.values()) {
    if (connection.userId !== userId) {
      continue;
    }
    sendDeviceEnvelope(connection.socket, {
      type: "devices-snapshot",
      payload: { devices }
    });
    sendDeviceEnvelope(connection.socket, {
      type: "directory-snapshot",
      payload: { directory }
    });
  }
}
async function handleHttpRequest(request, response) {
  writeCorsHeaders(response);
  if (request.method === "OPTIONS") {
    response.statusCode = 204;
    response.end();
    return;
  }
  const origin = resolveRequestOrigin(request);
  const url = new URL(request.url || "/", origin);
  const pathname = url.pathname;
  if (request.method === "GET" && pathname === routePath("/health")) {
    serveJson(response, buildHealthSnapshot(request));
    return;
  }
  if (isGetOrHead(request) && pathname === routePath("/updates/latest.json")) {
    const manifestPath = (0, import_path2.join)(UPDATES_DIR, "latest.json");
    if (!(0, import_fs2.existsSync)(manifestPath)) {
      serveJson(response, { ok: false, message: "update manifest not found" }, 404, { omitBody: request.method === "HEAD" });
      return;
    }
    try {
      serveJson(response, JSON.parse((0, import_fs2.readFileSync)(manifestPath, "utf-8")), 200, { omitBody: request.method === "HEAD" });
    } catch (error) {
      serveJson(
        response,
        { ok: false, message: `invalid update manifest: ${error instanceof Error ? error.message : String(error)}` },
        500,
        { omitBody: request.method === "HEAD" }
      );
    }
    return;
  }
  if (isGetOrHead(request) && pathname.startsWith(routePath("/updates/"))) {
    const filePath = resolveUpdateFilePath(pathname);
    if (!filePath || !(0, import_fs2.existsSync)(filePath)) {
      serveJson(response, { ok: false, message: "update file not found" }, 404, { omitBody: request.method === "HEAD" });
      return;
    }
    const fileStat = (0, import_fs2.statSync)(filePath);
    response.statusCode = 200;
    response.setHeader("Content-Type", filePath.endsWith(".apk") ? "application/vnd.android.package-archive" : "application/octet-stream");
    response.setHeader("Content-Length", fileStat.size);
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    (0, import_fs2.createReadStream)(filePath).pipe(response);
    return;
  }
  if (request.method === "GET" && (pathname === routePath("/") || pathname === routePath("/login"))) {
    serveHtml(response, buildAuthPage("login"));
    return;
  }
  if (request.method === "GET" && pathname === routePath("/register")) {
    serveHtml(response, buildAuthPage("register"));
    return;
  }
  if (request.method === "POST" && pathname === routePath("/api/auth/register")) {
    try {
      const body = await readJsonBody(request);
      const user = store.register(asString2(body.username), asString2(body.password));
      serveJson(response, { ok: true, user }, 201);
    } catch (error) {
      serveJson(response, { ok: false, message: error instanceof Error ? error.message : String(error) }, 400);
    }
    return;
  }
  if (request.method === "POST" && pathname === routePath("/api/auth/login")) {
    try {
      const body = await readJsonBody(request);
      const login = store.login(asString2(body.username), asString2(body.password));
      serveJson(response, buildAuthPayload(request, login.user, login.token));
    } catch (error) {
      serveJson(response, { ok: false, message: error instanceof Error ? error.message : String(error) }, 401);
    }
    return;
  }
  if (request.method === "GET" && pathname === routePath("/api/auth/me")) {
    const accessToken = extractAccessToken(request, url);
    const user = accessToken ? store.authenticate(accessToken) : null;
    if (!user) {
      serveJson(response, { ok: false, message: "unauthorized" }, 401);
      return;
    }
    serveJson(response, buildAuthPayload(request, user));
    return;
  }
  if (request.method === "GET" && pathname === routePath("/api/devices")) {
    const accessToken = extractAccessToken(request, url);
    const user = accessToken ? store.authenticate(accessToken) : null;
    if (!user) {
      serveJson(response, { ok: false, message: "unauthorized" }, 401);
      return;
    }
    serveJson(response, {
      ok: true,
      user,
      devices: store.listDevices(user.id)
    });
    return;
  }
  if (request.method === "GET" && pathname === routePath("/api/directory")) {
    const accessToken = extractAccessToken(request, url);
    const user = accessToken ? store.authenticate(accessToken) : null;
    if (!user) {
      serveJson(response, { ok: false, message: "unauthorized" }, 401);
      return;
    }
    serveJson(response, {
      ok: true,
      user,
      directory: store.getAccountDirectory(user.id)
    });
    return;
  }
  if (request.method === "GET" && pathname === routePath("/api/debug/client-devices")) {
    const accessToken = extractAccessToken(request, url);
    const user = accessToken ? store.authenticate(accessToken) : null;
    if (!user) {
      serveJson(response, { ok: false, message: "unauthorized" }, 401);
      return;
    }
    serveJson(response, {
      ok: true,
      user,
      devices: clientDebugStore.listDeviceSummaries(user.id)
    });
    return;
  }
  if (request.method === "GET" && pathname === routePath("/api/debug/client-device-logs")) {
    const accessToken = extractAccessToken(request, url);
    const user = accessToken ? store.authenticate(accessToken) : null;
    if (!user) {
      serveJson(response, { ok: false, message: "unauthorized" }, 401);
      return;
    }
    const deviceId = asString2(url.searchParams.get("deviceId"));
    if (!deviceId) {
      serveJson(response, { ok: false, message: "deviceId is required" }, 400);
      return;
    }
    const limit = Number.parseInt(asString2(url.searchParams.get("limit")) || "200", 10);
    const scopeIncludes = asString2(url.searchParams.get("scope"));
    serveJson(response, {
      ok: true,
      user,
      deviceId,
      entries: clientDebugStore.listLogs(user.id, {
        deviceId,
        limit: Number.isFinite(limit) ? limit : 200,
        scopeIncludes: scopeIncludes || void 0
      })
    });
    return;
  }
  if (request.method === "GET" && pathname === routePath("/api/debug/client-device-snapshot")) {
    const accessToken = extractAccessToken(request, url);
    const user = accessToken ? store.authenticate(accessToken) : null;
    if (!user) {
      serveJson(response, { ok: false, message: "unauthorized" }, 401);
      return;
    }
    const deviceId = asString2(url.searchParams.get("deviceId"));
    if (!deviceId) {
      serveJson(response, { ok: false, message: "deviceId is required" }, 400);
      return;
    }
    serveJson(response, {
      ok: true,
      user,
      deviceId,
      snapshot: clientDebugStore.getSnapshot(user.id, deviceId)
    });
    return;
  }
  if (request.method === "POST" && pathname === routePath("/api/debug/client-device-request")) {
    const accessToken = extractAccessToken(request, url);
    const user = accessToken ? store.authenticate(accessToken) : null;
    if (!user) {
      serveJson(response, { ok: false, message: "unauthorized" }, 401);
      return;
    }
    const body = await readJsonBody(request);
    const deviceId = asString2(body.deviceId);
    if (!deviceId) {
      serveJson(response, { ok: false, message: "deviceId is required" }, 400);
      return;
    }
    const requestId = (0, import_crypto2.randomUUID)();
    let delivered = 0;
    for (const connection of deviceStreams.values()) {
      if (connection.userId !== user.id || connection.deviceId !== deviceId) {
        continue;
      }
      sendDeviceEnvelope(connection.socket, {
        type: "client-debug-request",
        payload: {
          requestId,
          reason: asString2(body.reason) || "remote-http-debug-request",
          includeSnapshot: body.includeSnapshot !== false,
          includeLogs: body.includeLogs !== false,
          logLimit: typeof body.logLimit === "number" && Number.isFinite(body.logLimit) ? body.logLimit : 120
        }
      });
      delivered += 1;
    }
    serveJson(response, {
      ok: true,
      user,
      deviceId,
      requestId,
      delivered
    });
    return;
  }
  serveJson(response, { ok: false, message: "not found" }, 404);
}
var server = (0, import_http.createServer)((request, response) => {
  handleHttpRequest(request, response).catch((error) => {
    serveJson(response, { ok: false, message: error instanceof Error ? error.message : String(error) }, 500);
  });
});
var wss = new import_websocket_server.default({ noServer: true });
function closeClientPeer(peerId, reason, options) {
  const client = clients.get(peerId);
  const idleEntry = [...idleClients.entries()].find(([, candidate]) => candidate.peerId === peerId) || null;
  const target = client || idleEntry?.[1] || null;
  if (!target) {
    return;
  }
  clients.delete(peerId);
  if (idleEntry) {
    idleClients.delete(idleEntry[0]);
  }
  if (target.idleTimer) {
    clearTimeout(target.idleTimer);
    target.idleTimer = null;
  }
  if (options?.notifyHost) {
    const host = hosts.get(hostKey(target.userId, target.hostId));
    if (host) {
      sendHostEnvelope(host.socket, {
        type: "relay-peer-close",
        peerId: target.peerId,
        reason
      });
    }
  }
  if (target.socket.readyState < import_websocket.default.CLOSING) {
    target.socket.close(1013, reason.slice(0, 120));
  }
}
function closeIdleClientPeer(leaseKey, reason) {
  const client = idleClients.get(leaseKey);
  if (!client) {
    return;
  }
  idleClients.delete(leaseKey);
  clients.delete(client.peerId);
  client.idleTimer = null;
  const host = hosts.get(hostKey(client.userId, client.hostId));
  if (host) {
    sendHostEnvelope(host.socket, {
      type: "relay-peer-close",
      peerId: client.peerId,
      reason
    });
  }
  if (client.socket.readyState < import_websocket.default.CLOSING) {
    client.socket.close(1013, reason.slice(0, 120));
  }
}
function markClientPeerIdle(client, reason) {
  const leaseKey = clientPeerLeaseKey(client.userId, client.hostId, client.deviceId);
  if (!leaseKey) {
    closeClientPeer(client.peerId, reason, { notifyHost: true });
    return;
  }
  clients.delete(client.peerId);
  if (client.idleTimer) {
    clearTimeout(client.idleTimer);
  }
  client.idleSince = Date.now();
  client.lastIdleReason = reason;
  idleClients.set(leaseKey, client);
  client.idleTimer = setTimeout(() => closeIdleClientPeer(leaseKey, reason), RELAY_CLIENT_PEER_IDLE_TIMEOUT_MS);
  client.idleTimer.unref?.();
}
function resumeIdleClientPeer(options) {
  const leaseKey = clientPeerLeaseKey(options.userId, options.hostId, options.deviceId);
  if (!leaseKey) {
    return null;
  }
  const existing = idleClients.get(leaseKey) || null;
  if (!existing) {
    return null;
  }
  idleClients.delete(leaseKey);
  if (existing.idleTimer) {
    clearTimeout(existing.idleTimer);
  }
  existing.socket = options.socket;
  existing.username = options.username;
  existing.idleTimer = null;
  existing.idleSince = null;
  existing.lastIdleReason = null;
  clients.set(existing.peerId, existing);
  return existing;
}
function findActiveClientPeerByLeaseKey(leaseKey) {
  if (!leaseKey) {
    return null;
  }
  for (const client of clients.values()) {
    if (clientPeerLeaseKey(client.userId, client.hostId, client.deviceId) === leaseKey) {
      return client;
    }
  }
  return null;
}
function bindClientPeerSocket(client, socket, username) {
  const previousSocket = client.socket;
  client.socket = socket;
  client.username = username;
  client.idleSince = null;
  client.lastIdleReason = null;
  if (client.idleTimer) {
    clearTimeout(client.idleTimer);
    client.idleTimer = null;
  }
  clients.set(client.peerId, client);
  if (previousSocket !== socket && previousSocket.readyState < import_websocket.default.CLOSING) {
    previousSocket.close(1e3, "relay client socket replaced");
  }
}
function clearIdleClientPeersForHost(userId, hostId, reason) {
  for (const [leaseKey, client] of [...idleClients.entries()]) {
    if (client.userId !== userId || client.hostId !== hostId) {
      continue;
    }
    idleClients.delete(leaseKey);
    if (client.idleTimer) {
      clearTimeout(client.idleTimer);
      client.idleTimer = null;
    }
    if (client.socket.readyState < import_websocket.default.CLOSING) {
      client.socket.close(1013, reason.slice(0, 120));
    }
  }
}
function closeHost(host, reason) {
  const key = hostKey(host.userId, host.hostId);
  if (hosts.get(key)?.socket === host.socket) {
    hosts.delete(key);
  }
  const hasOtherDaemon = removeLivePresence(liveDaemonDevices, key, host.userId, host.deviceId);
  store.setDaemonConnected({
    userId: host.userId,
    deviceId: host.deviceId,
    hostId: host.hostId,
    daemonVersion: host.daemonVersion,
    connected: hasOtherDaemon
  });
  broadcastDevices(host.userId);
  for (const client of [...clients.values()]) {
    if (client.userId === host.userId && client.hostId === host.hostId) {
      closeClientPeer(client.peerId, reason);
    }
  }
  clearIdleClientPeersForHost(host.userId, host.hostId, reason);
}
function registerHost(ws, request, url) {
  const accessToken = extractAccessToken(request, url);
  const user = accessToken ? store.authenticate(accessToken) : null;
  const hostId = asString2(url.searchParams.get("hostId"));
  const deviceId = asString2(url.searchParams.get("deviceId"));
  const deviceName = asString2(url.searchParams.get("deviceName"));
  const platform = asString2(url.searchParams.get("platform"));
  const appVersion = asString2(url.searchParams.get("appVersion"));
  const daemonVersion = asString2(url.searchParams.get("daemonVersion"));
  if (!user || !hostId || !deviceId) {
    ws.send(JSON.stringify({ type: "relay-error", reason: "unauthorized host registration" }));
    ws.close(4001, "unauthorized");
    return;
  }
  const key = hostKey(user.id, hostId);
  if (hosts.has(key)) {
    ws.send(JSON.stringify({ type: "relay-error", reason: `host ${hostId} already connected` }));
    ws.close(4009, "host already connected");
    return;
  }
  const host = {
    socket: ws,
    userId: user.id,
    username: user.username,
    hostId,
    deviceId,
    daemonVersion
  };
  hosts.set(key, host);
  addLivePresence(liveDaemonDevices, key, user.id, deviceId);
  store.setDaemonConnected({
    userId: user.id,
    deviceId,
    hostId,
    deviceName,
    platform,
    appVersion,
    daemonVersion,
    connected: true
  });
  broadcastDevices(user.id);
  sendHostEnvelope(ws, { type: "relay-ready", hostId });
  ws.on("message", (raw) => {
    try {
      const envelope = JSON.parse(String(raw));
      if (envelope.type === "directory-update") {
        validateRelayDirectoryUpdatePayload(envelope.directory);
        store.publishDaemonDirectory({
          userId: user.id,
          deviceId,
          hostId,
          deviceName,
          platform,
          appVersion,
          daemonVersion,
          endpoints: envelope.directory?.endpoints,
          sessions: envelope.directory?.sessions,
          publishedAt: envelope.directory?.publishedAt
        });
        broadcastDevices(user.id);
        return;
      }
      if (!envelope.peerId) {
        return;
      }
      const client = clients.get(envelope.peerId);
      if (!client) {
        return;
      }
      if (envelope.type === "relay-peer-close") {
        closeClientPeer(envelope.peerId, envelope.reason || "host closed relay peer");
        return;
      }
      if (envelope.type !== "relay-signal" || !envelope.message) {
        return;
      }
      if (client.socket.readyState === import_websocket.default.OPEN) {
        client.socket.send(JSON.stringify(envelope.message));
      }
    } catch (error) {
      sendHostEnvelope(ws, {
        type: "relay-error",
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  });
  ws.on("close", () => closeHost(host, "host relay disconnected"));
  ws.on("error", () => closeHost(host, "host relay websocket error"));
}
function registerClient(ws, request, url) {
  const accessToken = extractAccessToken(request, url);
  const user = accessToken ? store.authenticate(accessToken) : null;
  const hostId = asString2(url.searchParams.get("hostId"));
  const deviceId = asString2(url.searchParams.get("deviceId"));
  if (!user || !hostId || !deviceId) {
    const message = !user ? "unauthorized relay client" : !hostId ? "hostId is required" : "deviceId is required";
    ws.send(JSON.stringify({ type: "rtc-error", payload: { message } }));
    ws.close(!user ? 4001 : 4e3, message);
    return;
  }
  const host = hosts.get(hostKey(user.id, hostId));
  if (!host) {
    ws.send(JSON.stringify({ type: "rtc-error", payload: { message: `host ${hostId} is offline` } }));
    ws.close(4404, "host offline");
    return;
  }
  const leaseKey = clientPeerLeaseKey(user.id, hostId, deviceId);
  const activeClient = findActiveClientPeerByLeaseKey(leaseKey);
  const resumedClient = !activeClient && deviceId ? resumeIdleClientPeer({
    userId: user.id,
    username: user.username,
    hostId,
    deviceId,
    socket: ws
  }) : null;
  const client = activeClient || resumedClient || {
    socket: ws,
    userId: user.id,
    username: user.username,
    hostId,
    deviceId,
    peerId: (0, import_crypto2.randomUUID)(),
    idleTimer: null,
    idleSince: null,
    lastIdleReason: null
  };
  bindClientPeerSocket(client, ws, user.username);
  ws.on("message", (raw) => {
    try {
      const message = JSON.parse(String(raw));
      sendHostEnvelope(host.socket, {
        type: "relay-signal",
        peerId: client.peerId,
        message
      });
      if (message.type === "rtc-close") {
        closeClientPeer(client.peerId, "client explicit rtc close");
      }
    } catch (error) {
      if (ws.readyState === import_websocket.default.OPEN) {
        ws.send(JSON.stringify({
          type: "rtc-error",
          payload: { message: error instanceof Error ? error.message : String(error) }
        }));
      }
    }
  });
  ws.on("close", () => {
    if (client.socket !== ws || !clients.has(client.peerId)) {
      return;
    }
    markClientPeerIdle(client, "client relay websocket closed");
  });
  ws.on("error", () => {
    if (client.socket !== ws || !clients.has(client.peerId)) {
      return;
    }
    markClientPeerIdle(client, "client relay websocket error");
  });
}
function registerDeviceStream(ws, request, url) {
  const accessToken = extractAccessToken(request, url);
  const user = accessToken ? store.authenticate(accessToken) : null;
  if (!user) {
    sendDeviceEnvelope(ws, { type: "relay-error", reason: "unauthorized devices stream" });
    ws.close(4001, "unauthorized");
    return;
  }
  const connectionId = (0, import_crypto2.randomUUID)();
  const deviceId = asString2(url.searchParams.get("deviceId"));
  const deviceName = asString2(url.searchParams.get("deviceName"));
  const platform = asString2(url.searchParams.get("platform"));
  const appVersion = asString2(url.searchParams.get("appVersion"));
  const connection = {
    id: connectionId,
    socket: ws,
    userId: user.id,
    username: user.username,
    deviceId,
    deviceName,
    platform,
    appVersion
  };
  deviceStreams.set(connectionId, connection);
  if (deviceId) {
    addLivePresence(liveClientDevices, connectionId, user.id, deviceId);
    store.setClientConnected({
      userId: user.id,
      deviceId,
      deviceName,
      platform,
      appVersion,
      connected: true
    });
  }
  broadcastDevices(user.id);
  sendDeviceEnvelope(ws, {
    type: "devices-snapshot",
    payload: { devices: store.listDevices(user.id) }
  });
  sendDeviceEnvelope(ws, {
    type: "directory-snapshot",
    payload: { directory: store.getAccountDirectory(user.id) }
  });
  ws.on("message", (raw) => {
    try {
      const message = JSON.parse(String(raw));
      if (message.type === "devices-request") {
        if (connection.deviceId) {
          store.setClientConnected({
            userId: user.id,
            deviceId: connection.deviceId,
            deviceName: asString2(message.payload?.deviceName) || connection.deviceName,
            platform: asString2(message.payload?.platform) || connection.platform,
            appVersion: asString2(message.payload?.appVersion) || connection.appVersion,
            connected: true
          });
          broadcastDevices(user.id);
        } else {
          sendDeviceEnvelope(ws, {
            type: "devices-snapshot",
            payload: { devices: store.listDevices(user.id) }
          });
          sendDeviceEnvelope(ws, {
            type: "directory-snapshot",
            payload: { directory: store.getAccountDirectory(user.id) }
          });
        }
        return;
      }
      if (message.type === "device-meta") {
        const nextDeviceId = asString2(message.payload?.deviceId) || connection.deviceId;
        if (!nextDeviceId) {
          throw new Error("deviceId is required for device-meta");
        }
        if (!connection.deviceId) {
          connection.deviceId = nextDeviceId;
          addLivePresence(liveClientDevices, connection.id, user.id, nextDeviceId);
        }
        connection.deviceName = asString2(message.payload?.deviceName) || connection.deviceName;
        connection.platform = asString2(message.payload?.platform) || connection.platform;
        connection.appVersion = asString2(message.payload?.appVersion) || connection.appVersion;
        store.setClientConnected({
          userId: user.id,
          deviceId: connection.deviceId,
          deviceName: connection.deviceName,
          platform: connection.platform,
          appVersion: connection.appVersion,
          connected: true
        });
        broadcastDevices(user.id);
        return;
      }
      if (message.type === "client-debug-log") {
        const relayDeviceId = asString2(message.payload?.deviceId) || connection.deviceId;
        if (!relayDeviceId) {
          throw new Error("deviceId is required for client-debug-log");
        }
        clientDebugStore.appendLogs(
          user.id,
          relayDeviceId,
          Array.isArray(message.payload?.entries) ? message.payload.entries : []
        );
        return;
      }
      if (message.type === "client-debug-snapshot") {
        const relayDeviceId = asString2(message.payload?.deviceId) || connection.deviceId;
        if (!relayDeviceId) {
          throw new Error("deviceId is required for client-debug-snapshot");
        }
        clientDebugStore.setSnapshot(user.id, relayDeviceId, {
          requestId: asString2(message.payload?.requestId),
          reason: asString2(message.payload?.reason),
          snapshot: message.payload?.snapshot
        });
      }
    } catch (error) {
      sendDeviceEnvelope(ws, {
        type: "relay-error",
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  });
  const finalize = () => {
    deviceStreams.delete(connectionId);
    if (connection.deviceId) {
      const stillConnected = removeLivePresence(liveClientDevices, connectionId, user.id, connection.deviceId);
      store.setClientConnected({
        userId: user.id,
        deviceId: connection.deviceId,
        deviceName: connection.deviceName,
        platform: connection.platform,
        appVersion: connection.appVersion,
        connected: stillConnected
      });
    }
    broadcastDevices(user.id);
  };
  ws.on("close", finalize);
  ws.on("error", finalize);
}
server.on("upgrade", (request, socket, head) => {
  const origin = resolveRequestOrigin(request);
  const url = new URL(request.url || "/", origin);
  const pathname = url.pathname;
  if (pathname !== routePath("/ws/host") && pathname !== routePath("/ws/client") && pathname !== routePath("/ws/devices")) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    if (pathname === routePath("/ws/host")) {
      registerHost(ws, request, url);
      return;
    }
    if (pathname === routePath("/ws/devices")) {
      registerDeviceStream(ws, request, url);
      return;
    }
    registerClient(ws, request, url);
  });
});
server.listen(PORT, HOST, () => {
  console.log(`[${(/* @__PURE__ */ new Date()).toISOString()}] zterm traversal relay listening on http://${HOST}:${PORT}${BASE_PATH || ""}`);
  console.log(`  - health: http://${HOST}:${PORT}${routePath("/health")}`);
  console.log(`  - login page: http://${HOST}:${PORT}${routePath("/login")}`);
  console.log(`  - register: POST http://${HOST}:${PORT}${routePath("/api/auth/register")}`);
  console.log(`  - login: POST http://${HOST}:${PORT}${routePath("/api/auth/login")}`);
  console.log(`  - devices: GET http://${HOST}:${PORT}${routePath("/api/devices")}`);
  console.log(`  - devices ws: ws://${HOST}:${PORT}${routePath("/ws/devices")}?token=<access>&deviceId=<deviceId>`);
  console.log(`  - host ws: ws://${HOST}:${PORT}${routePath("/ws/host")}?token=<access>&hostId=<hostId>&deviceId=<deviceId>`);
  console.log(`  - client ws: ws://${HOST}:${PORT}${routePath("/ws/client")}?token=<access>&hostId=<hostId>&deviceId=<deviceId>`);
  console.log(`  - store: ${STORE_PATH}`);
  console.log(`  - turn: ${TURN_CONFIG ? TURN_CONFIG.url : "disabled"}`);
});
