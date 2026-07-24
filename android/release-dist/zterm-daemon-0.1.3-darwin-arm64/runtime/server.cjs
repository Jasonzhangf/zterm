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
    var { randomBytes, createHash: createHash2 } = require("crypto");
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
    var WebSocket3 = class _WebSocket extends EventEmitter {
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
    Object.defineProperty(WebSocket3, "CONNECTING", {
      enumerable: true,
      value: readyStates.indexOf("CONNECTING")
    });
    Object.defineProperty(WebSocket3.prototype, "CONNECTING", {
      enumerable: true,
      value: readyStates.indexOf("CONNECTING")
    });
    Object.defineProperty(WebSocket3, "OPEN", {
      enumerable: true,
      value: readyStates.indexOf("OPEN")
    });
    Object.defineProperty(WebSocket3.prototype, "OPEN", {
      enumerable: true,
      value: readyStates.indexOf("OPEN")
    });
    Object.defineProperty(WebSocket3, "CLOSING", {
      enumerable: true,
      value: readyStates.indexOf("CLOSING")
    });
    Object.defineProperty(WebSocket3.prototype, "CLOSING", {
      enumerable: true,
      value: readyStates.indexOf("CLOSING")
    });
    Object.defineProperty(WebSocket3, "CLOSED", {
      enumerable: true,
      value: readyStates.indexOf("CLOSED")
    });
    Object.defineProperty(WebSocket3.prototype, "CLOSED", {
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
      Object.defineProperty(WebSocket3.prototype, property, { enumerable: true });
    });
    ["open", "error", "close", "message"].forEach((method) => {
      Object.defineProperty(WebSocket3.prototype, `on${method}`, {
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
    WebSocket3.prototype.addEventListener = addEventListener;
    WebSocket3.prototype.removeEventListener = removeEventListener;
    module2.exports = WebSocket3;
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
      const key = randomBytes(16).toString("base64");
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
        if (websocket.readyState !== WebSocket3.CONNECTING) return;
        req = websocket._req = null;
        const upgrade = res.headers.upgrade;
        if (upgrade === void 0 || upgrade.toLowerCase() !== "websocket") {
          abortHandshake(websocket, socket, "Invalid Upgrade header");
          return;
        }
        const digest = createHash2("sha1").update(key + GUID).digest("base64");
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
      websocket._readyState = WebSocket3.CLOSING;
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
      websocket._readyState = WebSocket3.CLOSING;
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
      if (websocket.readyState === WebSocket3.CLOSED) return;
      if (websocket.readyState === WebSocket3.OPEN) {
        websocket._readyState = WebSocket3.CLOSING;
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
      websocket._readyState = WebSocket3.CLOSING;
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
      websocket._readyState = WebSocket3.CLOSING;
      websocket._receiver.end();
      this.end();
    }
    function socketOnError() {
      const websocket = this[kWebSocket];
      this.removeListener("error", socketOnError);
      this.on("error", NOOP);
      if (websocket) {
        websocket._readyState = WebSocket3.CLOSING;
        this.destroy();
      }
    }
  }
});

// ../node_modules/.pnpm/ws@8.20.0/node_modules/ws/lib/stream.js
var require_stream = __commonJS({
  "../node_modules/.pnpm/ws@8.20.0/node_modules/ws/lib/stream.js"(exports2, module2) {
    "use strict";
    var WebSocket3 = require_websocket();
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
    var { createHash: createHash2 } = require("crypto");
    var extension2 = require_extension();
    var PerMessageDeflate2 = require_permessage_deflate();
    var subprotocol2 = require_subprotocol();
    var WebSocket3 = require_websocket();
    var { CLOSE_TIMEOUT, GUID, kWebSocket } = require_constants();
    var keyRegex = /^[+/0-9A-Za-z]{22}==$/;
    var RUNNING = 0;
    var CLOSING2 = 1;
    var CLOSED2 = 2;
    var WebSocketServer3 = class extends EventEmitter {
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
          WebSocket: WebSocket3,
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
        if (this._state === CLOSED2) {
          if (cb) {
            this.once("close", () => {
              cb(new Error("The server is not running"));
            });
          }
          process.nextTick(emitClose, this);
          return;
        }
        if (cb) this.once("close", cb);
        if (this._state === CLOSING2) return;
        this._state = CLOSING2;
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
        const digest = createHash2("sha1").update(key + GUID).digest("base64");
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
    module2.exports = WebSocketServer3;
    function addListeners(server2, map) {
      for (const event of Object.keys(map)) server2.on(event, map[event]);
      return function removeListeners() {
        for (const event of Object.keys(map)) {
          server2.removeListener(event, map[event]);
        }
      };
    }
    function emitClose(server2) {
      server2._state = CLOSED2;
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

// ../node_modules/.pnpm/@roamhq+wrtc@0.10.0/node_modules/@roamhq/wrtc/lib/binding.js
var require_binding = __commonJS({
  "../node_modules/.pnpm/@roamhq+wrtc@0.10.0/node_modules/@roamhq/wrtc/lib/binding.js"(exports2, module2) {
    "use strict";
    var os = require("os");
    var triple = `${os.platform()}-${os.arch()}`;
    var pathsToTry = [
      `../build-${triple}/wrtc.node`,
      `../build-${triple}/Debug/wrtc.node`,
      `../build-${triple}/Release/wrtc.node`,
      `@roamhq/wrtc-${triple}`,
      // For installations that can't resolve node_modules directly, like AWS Lambda
      `./node_modules/@roamhq/wrtc-${triple}`,
      `./node_modules/@roamhq/wrtc-${triple}/wrtc.node`
    ];
    var succeeded = false;
    for (const path of pathsToTry) {
      try {
        module2.exports = require(path);
        succeeded = true;
        break;
      } catch (error) {
        void error;
      }
    }
    if (!succeeded) {
      throw new Error(
        `Could not find wrtc binary on any of the paths: ${pathsToTry}`
      );
    }
  }
});

// ../node_modules/.pnpm/@roamhq+wrtc@0.10.0/node_modules/@roamhq/wrtc/lib/eventtarget.js
var require_eventtarget = __commonJS({
  "../node_modules/.pnpm/@roamhq+wrtc@0.10.0/node_modules/@roamhq/wrtc/lib/eventtarget.js"(exports2, module2) {
    "use strict";
    function EventTarget() {
      this._listeners = {};
    }
    EventTarget.prototype.addEventListener = function addEventListener(type, listener) {
      const listeners = this._listeners = this._listeners || {};
      if (!listeners[type]) {
        listeners[type] = /* @__PURE__ */ new Set();
      }
      listeners[type].add(listener);
    };
    EventTarget.prototype.dispatchEvent = function dispatchEvent(event) {
      let listeners = this._listeners = this._listeners || {};
      process.nextTick(() => {
        listeners = new Set(listeners[event.type] || []);
        const dummyListener = this["on" + event.type];
        if (typeof dummyListener === "function") {
          listeners.add(dummyListener);
        }
        listeners.forEach((listener) => {
          if (typeof listener === "object" && typeof listener.handleEvent === "function") {
            listener.handleEvent(event);
          } else {
            listener.call(this, event);
          }
        });
      });
    };
    EventTarget.prototype.removeEventListener = function removeEventListener(type, listener) {
      const listeners = this._listeners = this._listeners || {};
      if (listeners[type]) {
        listeners[type].delete(listener);
      }
    };
    module2.exports = EventTarget;
  }
});

// ../node_modules/.pnpm/@roamhq+wrtc@0.10.0/node_modules/@roamhq/wrtc/lib/mediadevices.js
var require_mediadevices = __commonJS({
  "../node_modules/.pnpm/@roamhq+wrtc@0.10.0/node_modules/@roamhq/wrtc/lib/mediadevices.js"(exports2, module2) {
    "use strict";
    var inherits = require("util").inherits;
    var { getDisplayMedia, getUserMedia } = require_binding();
    var EventTarget = require_eventtarget();
    function MediaDevices() {
    }
    inherits(MediaDevices, EventTarget);
    MediaDevices.prototype.enumerateDevices = function enumerateDevices() {
      throw new Error(
        "Not yet implemented; file a feature request against node-webrtc"
      );
    };
    MediaDevices.prototype.getSupportedConstraints = function getSupportedConstraints() {
      return {
        width: true,
        height: true
      };
    };
    MediaDevices.prototype.getDisplayMedia = getDisplayMedia;
    MediaDevices.prototype.getUserMedia = getUserMedia;
    module2.exports = MediaDevices;
  }
});

// ../node_modules/.pnpm/webidl-conversions@7.0.0/node_modules/webidl-conversions/lib/index.js
var require_lib = __commonJS({
  "../node_modules/.pnpm/webidl-conversions@7.0.0/node_modules/webidl-conversions/lib/index.js"(exports2) {
    "use strict";
    function makeException(ErrorType, message, options) {
      if (options.globals) {
        ErrorType = options.globals[ErrorType.name];
      }
      return new ErrorType(`${options.context ? options.context : "Value"} ${message}.`);
    }
    function toNumber(value, options) {
      if (typeof value === "bigint") {
        throw makeException(TypeError, "is a BigInt which cannot be converted to a number", options);
      }
      if (!options.globals) {
        return Number(value);
      }
      return options.globals.Number(value);
    }
    function evenRound(x) {
      if (x > 0 && x % 1 === 0.5 && (x & 1) === 0 || x < 0 && x % 1 === -0.5 && (x & 1) === 1) {
        return censorNegativeZero(Math.floor(x));
      }
      return censorNegativeZero(Math.round(x));
    }
    function integerPart(n) {
      return censorNegativeZero(Math.trunc(n));
    }
    function sign(x) {
      return x < 0 ? -1 : 1;
    }
    function modulo(x, y) {
      const signMightNotMatch = x % y;
      if (sign(y) !== sign(signMightNotMatch)) {
        return signMightNotMatch + y;
      }
      return signMightNotMatch;
    }
    function censorNegativeZero(x) {
      return x === 0 ? 0 : x;
    }
    function createIntegerConversion(bitLength, { unsigned }) {
      let lowerBound, upperBound;
      if (unsigned) {
        lowerBound = 0;
        upperBound = 2 ** bitLength - 1;
      } else {
        lowerBound = -(2 ** (bitLength - 1));
        upperBound = 2 ** (bitLength - 1) - 1;
      }
      const twoToTheBitLength = 2 ** bitLength;
      const twoToOneLessThanTheBitLength = 2 ** (bitLength - 1);
      return (value, options = {}) => {
        let x = toNumber(value, options);
        x = censorNegativeZero(x);
        if (options.enforceRange) {
          if (!Number.isFinite(x)) {
            throw makeException(TypeError, "is not a finite number", options);
          }
          x = integerPart(x);
          if (x < lowerBound || x > upperBound) {
            throw makeException(
              TypeError,
              `is outside the accepted range of ${lowerBound} to ${upperBound}, inclusive`,
              options
            );
          }
          return x;
        }
        if (!Number.isNaN(x) && options.clamp) {
          x = Math.min(Math.max(x, lowerBound), upperBound);
          x = evenRound(x);
          return x;
        }
        if (!Number.isFinite(x) || x === 0) {
          return 0;
        }
        x = integerPart(x);
        if (x >= lowerBound && x <= upperBound) {
          return x;
        }
        x = modulo(x, twoToTheBitLength);
        if (!unsigned && x >= twoToOneLessThanTheBitLength) {
          return x - twoToTheBitLength;
        }
        return x;
      };
    }
    function createLongLongConversion(bitLength, { unsigned }) {
      const upperBound = Number.MAX_SAFE_INTEGER;
      const lowerBound = unsigned ? 0 : Number.MIN_SAFE_INTEGER;
      const asBigIntN = unsigned ? BigInt.asUintN : BigInt.asIntN;
      return (value, options = {}) => {
        let x = toNumber(value, options);
        x = censorNegativeZero(x);
        if (options.enforceRange) {
          if (!Number.isFinite(x)) {
            throw makeException(TypeError, "is not a finite number", options);
          }
          x = integerPart(x);
          if (x < lowerBound || x > upperBound) {
            throw makeException(
              TypeError,
              `is outside the accepted range of ${lowerBound} to ${upperBound}, inclusive`,
              options
            );
          }
          return x;
        }
        if (!Number.isNaN(x) && options.clamp) {
          x = Math.min(Math.max(x, lowerBound), upperBound);
          x = evenRound(x);
          return x;
        }
        if (!Number.isFinite(x) || x === 0) {
          return 0;
        }
        let xBigInt = BigInt(integerPart(x));
        xBigInt = asBigIntN(bitLength, xBigInt);
        return Number(xBigInt);
      };
    }
    exports2.any = (value) => {
      return value;
    };
    exports2.undefined = () => {
      return void 0;
    };
    exports2.boolean = (value) => {
      return Boolean(value);
    };
    exports2.byte = createIntegerConversion(8, { unsigned: false });
    exports2.octet = createIntegerConversion(8, { unsigned: true });
    exports2.short = createIntegerConversion(16, { unsigned: false });
    exports2["unsigned short"] = createIntegerConversion(16, { unsigned: true });
    exports2.long = createIntegerConversion(32, { unsigned: false });
    exports2["unsigned long"] = createIntegerConversion(32, { unsigned: true });
    exports2["long long"] = createLongLongConversion(64, { unsigned: false });
    exports2["unsigned long long"] = createLongLongConversion(64, { unsigned: true });
    exports2.double = (value, options = {}) => {
      const x = toNumber(value, options);
      if (!Number.isFinite(x)) {
        throw makeException(TypeError, "is not a finite floating-point value", options);
      }
      return x;
    };
    exports2["unrestricted double"] = (value, options = {}) => {
      const x = toNumber(value, options);
      return x;
    };
    exports2.float = (value, options = {}) => {
      const x = toNumber(value, options);
      if (!Number.isFinite(x)) {
        throw makeException(TypeError, "is not a finite floating-point value", options);
      }
      if (Object.is(x, -0)) {
        return x;
      }
      const y = Math.fround(x);
      if (!Number.isFinite(y)) {
        throw makeException(TypeError, "is outside the range of a single-precision floating-point value", options);
      }
      return y;
    };
    exports2["unrestricted float"] = (value, options = {}) => {
      const x = toNumber(value, options);
      if (isNaN(x)) {
        return x;
      }
      if (Object.is(x, -0)) {
        return x;
      }
      return Math.fround(x);
    };
    exports2.DOMString = (value, options = {}) => {
      if (options.treatNullAsEmptyString && value === null) {
        return "";
      }
      if (typeof value === "symbol") {
        throw makeException(TypeError, "is a symbol, which cannot be converted to a string", options);
      }
      const StringCtor = options.globals ? options.globals.String : String;
      return StringCtor(value);
    };
    exports2.ByteString = (value, options = {}) => {
      const x = exports2.DOMString(value, options);
      let c;
      for (let i = 0; (c = x.codePointAt(i)) !== void 0; ++i) {
        if (c > 255) {
          throw makeException(TypeError, "is not a valid ByteString", options);
        }
      }
      return x;
    };
    exports2.USVString = (value, options = {}) => {
      const S = exports2.DOMString(value, options);
      const n = S.length;
      const U = [];
      for (let i = 0; i < n; ++i) {
        const c = S.charCodeAt(i);
        if (c < 55296 || c > 57343) {
          U.push(String.fromCodePoint(c));
        } else if (56320 <= c && c <= 57343) {
          U.push(String.fromCodePoint(65533));
        } else if (i === n - 1) {
          U.push(String.fromCodePoint(65533));
        } else {
          const d = S.charCodeAt(i + 1);
          if (56320 <= d && d <= 57343) {
            const a = c & 1023;
            const b = d & 1023;
            U.push(String.fromCodePoint((2 << 15) + (2 << 9) * a + b));
            ++i;
          } else {
            U.push(String.fromCodePoint(65533));
          }
        }
      }
      return U.join("");
    };
    exports2.object = (value, options = {}) => {
      if (value === null || typeof value !== "object" && typeof value !== "function") {
        throw makeException(TypeError, "is not an object", options);
      }
      return value;
    };
    var abByteLengthGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength").get;
    var sabByteLengthGetter = typeof SharedArrayBuffer === "function" ? Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, "byteLength").get : null;
    function isNonSharedArrayBuffer(value) {
      try {
        abByteLengthGetter.call(value);
        return true;
      } catch {
        return false;
      }
    }
    function isSharedArrayBuffer(value) {
      try {
        sabByteLengthGetter.call(value);
        return true;
      } catch {
        return false;
      }
    }
    function isArrayBufferDetached(value) {
      try {
        new Uint8Array(value);
        return false;
      } catch {
        return true;
      }
    }
    exports2.ArrayBuffer = (value, options = {}) => {
      if (!isNonSharedArrayBuffer(value)) {
        if (options.allowShared && !isSharedArrayBuffer(value)) {
          throw makeException(TypeError, "is not an ArrayBuffer or SharedArrayBuffer", options);
        }
        throw makeException(TypeError, "is not an ArrayBuffer", options);
      }
      if (isArrayBufferDetached(value)) {
        throw makeException(TypeError, "is a detached ArrayBuffer", options);
      }
      return value;
    };
    var dvByteLengthGetter = Object.getOwnPropertyDescriptor(DataView.prototype, "byteLength").get;
    exports2.DataView = (value, options = {}) => {
      try {
        dvByteLengthGetter.call(value);
      } catch (e) {
        throw makeException(TypeError, "is not a DataView", options);
      }
      if (!options.allowShared && isSharedArrayBuffer(value.buffer)) {
        throw makeException(TypeError, "is backed by a SharedArrayBuffer, which is not allowed", options);
      }
      if (isArrayBufferDetached(value.buffer)) {
        throw makeException(TypeError, "is backed by a detached ArrayBuffer", options);
      }
      return value;
    };
    var typedArrayNameGetter = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(Uint8Array).prototype,
      Symbol.toStringTag
    ).get;
    [
      Int8Array,
      Int16Array,
      Int32Array,
      Uint8Array,
      Uint16Array,
      Uint32Array,
      Uint8ClampedArray,
      Float32Array,
      Float64Array
    ].forEach((func) => {
      const { name } = func;
      const article = /^[AEIOU]/u.test(name) ? "an" : "a";
      exports2[name] = (value, options = {}) => {
        if (!ArrayBuffer.isView(value) || typedArrayNameGetter.call(value) !== name) {
          throw makeException(TypeError, `is not ${article} ${name} object`, options);
        }
        if (!options.allowShared && isSharedArrayBuffer(value.buffer)) {
          throw makeException(TypeError, "is a view on a SharedArrayBuffer, which is not allowed", options);
        }
        if (isArrayBufferDetached(value.buffer)) {
          throw makeException(TypeError, "is a view on a detached ArrayBuffer", options);
        }
        return value;
      };
    });
    exports2.ArrayBufferView = (value, options = {}) => {
      if (!ArrayBuffer.isView(value)) {
        throw makeException(TypeError, "is not a view on an ArrayBuffer or SharedArrayBuffer", options);
      }
      if (!options.allowShared && isSharedArrayBuffer(value.buffer)) {
        throw makeException(TypeError, "is a view on a SharedArrayBuffer, which is not allowed", options);
      }
      if (isArrayBufferDetached(value.buffer)) {
        throw makeException(TypeError, "is a view on a detached ArrayBuffer", options);
      }
      return value;
    };
    exports2.BufferSource = (value, options = {}) => {
      if (ArrayBuffer.isView(value)) {
        if (!options.allowShared && isSharedArrayBuffer(value.buffer)) {
          throw makeException(TypeError, "is a view on a SharedArrayBuffer, which is not allowed", options);
        }
        if (isArrayBufferDetached(value.buffer)) {
          throw makeException(TypeError, "is a view on a detached ArrayBuffer", options);
        }
        return value;
      }
      if (!options.allowShared && !isNonSharedArrayBuffer(value)) {
        throw makeException(TypeError, "is not an ArrayBuffer or a view on one", options);
      }
      if (options.allowShared && !isSharedArrayBuffer(value) && !isNonSharedArrayBuffer(value)) {
        throw makeException(TypeError, "is not an ArrayBuffer, SharedArrayBuffer, or a view on one", options);
      }
      if (isArrayBufferDetached(value)) {
        throw makeException(TypeError, "is a detached ArrayBuffer", options);
      }
      return value;
    };
    exports2.DOMTimeStamp = exports2["unsigned long long"];
  }
});

// ../node_modules/.pnpm/domexception@4.0.0/node_modules/domexception/lib/utils.js
var require_utils = __commonJS({
  "../node_modules/.pnpm/domexception@4.0.0/node_modules/domexception/lib/utils.js"(exports2, module2) {
    "use strict";
    function isObject(value) {
      return typeof value === "object" && value !== null || typeof value === "function";
    }
    var hasOwn = Function.prototype.call.bind(Object.prototype.hasOwnProperty);
    function define(target, source) {
      for (const key of Reflect.ownKeys(source)) {
        const descriptor = Reflect.getOwnPropertyDescriptor(source, key);
        if (descriptor && !Reflect.defineProperty(target, key, descriptor)) {
          throw new TypeError(`Cannot redefine property: ${String(key)}`);
        }
      }
    }
    function newObjectInRealm(globalObject, object) {
      const ctorRegistry = initCtorRegistry(globalObject);
      return Object.defineProperties(
        Object.create(ctorRegistry["%Object.prototype%"]),
        Object.getOwnPropertyDescriptors(object)
      );
    }
    var wrapperSymbol = /* @__PURE__ */ Symbol("wrapper");
    var implSymbol = /* @__PURE__ */ Symbol("impl");
    var sameObjectCaches = /* @__PURE__ */ Symbol("SameObject caches");
    var ctorRegistrySymbol = /* @__PURE__ */ Symbol.for("[webidl2js] constructor registry");
    var AsyncIteratorPrototype = Object.getPrototypeOf(Object.getPrototypeOf(async function* () {
    }).prototype);
    function initCtorRegistry(globalObject) {
      if (hasOwn(globalObject, ctorRegistrySymbol)) {
        return globalObject[ctorRegistrySymbol];
      }
      const ctorRegistry = /* @__PURE__ */ Object.create(null);
      ctorRegistry["%Object.prototype%"] = globalObject.Object.prototype;
      ctorRegistry["%IteratorPrototype%"] = Object.getPrototypeOf(
        Object.getPrototypeOf(new globalObject.Array()[Symbol.iterator]())
      );
      try {
        ctorRegistry["%AsyncIteratorPrototype%"] = Object.getPrototypeOf(
          Object.getPrototypeOf(
            globalObject.eval("(async function* () {})").prototype
          )
        );
      } catch {
        ctorRegistry["%AsyncIteratorPrototype%"] = AsyncIteratorPrototype;
      }
      globalObject[ctorRegistrySymbol] = ctorRegistry;
      return ctorRegistry;
    }
    function getSameObject(wrapper, prop, creator) {
      if (!wrapper[sameObjectCaches]) {
        wrapper[sameObjectCaches] = /* @__PURE__ */ Object.create(null);
      }
      if (prop in wrapper[sameObjectCaches]) {
        return wrapper[sameObjectCaches][prop];
      }
      wrapper[sameObjectCaches][prop] = creator();
      return wrapper[sameObjectCaches][prop];
    }
    function wrapperForImpl(impl) {
      return impl ? impl[wrapperSymbol] : null;
    }
    function implForWrapper(wrapper) {
      return wrapper ? wrapper[implSymbol] : null;
    }
    function tryWrapperForImpl(impl) {
      const wrapper = wrapperForImpl(impl);
      return wrapper ? wrapper : impl;
    }
    function tryImplForWrapper(wrapper) {
      const impl = implForWrapper(wrapper);
      return impl ? impl : wrapper;
    }
    var iterInternalSymbol = /* @__PURE__ */ Symbol("internal");
    function isArrayIndexPropName(P) {
      if (typeof P !== "string") {
        return false;
      }
      const i = P >>> 0;
      if (i === 2 ** 32 - 1) {
        return false;
      }
      const s = `${i}`;
      if (P !== s) {
        return false;
      }
      return true;
    }
    var byteLengthGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength").get;
    function isArrayBuffer(value) {
      try {
        byteLengthGetter.call(value);
        return true;
      } catch (e) {
        return false;
      }
    }
    function iteratorResult([key, value], kind) {
      let result;
      switch (kind) {
        case "key":
          result = key;
          break;
        case "value":
          result = value;
          break;
        case "key+value":
          result = [key, value];
          break;
      }
      return { value: result, done: false };
    }
    var supportsPropertyIndex = /* @__PURE__ */ Symbol("supports property index");
    var supportedPropertyIndices = /* @__PURE__ */ Symbol("supported property indices");
    var supportsPropertyName = /* @__PURE__ */ Symbol("supports property name");
    var supportedPropertyNames = /* @__PURE__ */ Symbol("supported property names");
    var indexedGet = /* @__PURE__ */ Symbol("indexed property get");
    var indexedSetNew = /* @__PURE__ */ Symbol("indexed property set new");
    var indexedSetExisting = /* @__PURE__ */ Symbol("indexed property set existing");
    var namedGet = /* @__PURE__ */ Symbol("named property get");
    var namedSetNew = /* @__PURE__ */ Symbol("named property set new");
    var namedSetExisting = /* @__PURE__ */ Symbol("named property set existing");
    var namedDelete = /* @__PURE__ */ Symbol("named property delete");
    var asyncIteratorNext = /* @__PURE__ */ Symbol("async iterator get the next iteration result");
    var asyncIteratorReturn = /* @__PURE__ */ Symbol("async iterator return steps");
    var asyncIteratorInit = /* @__PURE__ */ Symbol("async iterator initialization steps");
    var asyncIteratorEOI = /* @__PURE__ */ Symbol("async iterator end of iteration");
    module2.exports = exports2 = {
      isObject,
      hasOwn,
      define,
      newObjectInRealm,
      wrapperSymbol,
      implSymbol,
      getSameObject,
      ctorRegistrySymbol,
      initCtorRegistry,
      wrapperForImpl,
      implForWrapper,
      tryWrapperForImpl,
      tryImplForWrapper,
      iterInternalSymbol,
      isArrayBuffer,
      isArrayIndexPropName,
      supportsPropertyIndex,
      supportedPropertyIndices,
      supportsPropertyName,
      supportedPropertyNames,
      indexedGet,
      indexedSetNew,
      indexedSetExisting,
      namedGet,
      namedSetNew,
      namedSetExisting,
      namedDelete,
      asyncIteratorNext,
      asyncIteratorReturn,
      asyncIteratorInit,
      asyncIteratorEOI,
      iteratorResult
    };
  }
});

// ../node_modules/.pnpm/domexception@4.0.0/node_modules/domexception/lib/legacy-error-codes.json
var require_legacy_error_codes = __commonJS({
  "../node_modules/.pnpm/domexception@4.0.0/node_modules/domexception/lib/legacy-error-codes.json"(exports2, module2) {
    module2.exports = {
      IndexSizeError: 1,
      HierarchyRequestError: 3,
      WrongDocumentError: 4,
      InvalidCharacterError: 5,
      NoModificationAllowedError: 7,
      NotFoundError: 8,
      NotSupportedError: 9,
      InUseAttributeError: 10,
      InvalidStateError: 11,
      SyntaxError: 12,
      InvalidModificationError: 13,
      NamespaceError: 14,
      InvalidAccessError: 15,
      TypeMismatchError: 17,
      SecurityError: 18,
      NetworkError: 19,
      AbortError: 20,
      URLMismatchError: 21,
      QuotaExceededError: 22,
      TimeoutError: 23,
      InvalidNodeTypeError: 24,
      DataCloneError: 25
    };
  }
});

// ../node_modules/.pnpm/domexception@4.0.0/node_modules/domexception/lib/DOMException-impl.js
var require_DOMException_impl = __commonJS({
  "../node_modules/.pnpm/domexception@4.0.0/node_modules/domexception/lib/DOMException-impl.js"(exports2) {
    "use strict";
    var legacyErrorCodes = require_legacy_error_codes();
    var idlUtils = require_utils();
    exports2.implementation = class DOMExceptionImpl {
      constructor(globalObject, [message, name]) {
        this.name = name;
        this.message = message;
      }
      get code() {
        return legacyErrorCodes[this.name] || 0;
      }
    };
    exports2.init = (impl) => {
      if (Error.captureStackTrace) {
        const wrapper = idlUtils.wrapperForImpl(impl);
        Error.captureStackTrace(wrapper, wrapper.constructor);
      }
    };
  }
});

// ../node_modules/.pnpm/domexception@4.0.0/node_modules/domexception/lib/DOMException.js
var require_DOMException = __commonJS({
  "../node_modules/.pnpm/domexception@4.0.0/node_modules/domexception/lib/DOMException.js"(exports2) {
    "use strict";
    var conversions = require_lib();
    var utils = require_utils();
    var implSymbol = utils.implSymbol;
    var ctorRegistrySymbol = utils.ctorRegistrySymbol;
    var interfaceName = "DOMException";
    exports2.is = (value) => {
      return utils.isObject(value) && utils.hasOwn(value, implSymbol) && value[implSymbol] instanceof Impl.implementation;
    };
    exports2.isImpl = (value) => {
      return utils.isObject(value) && value instanceof Impl.implementation;
    };
    exports2.convert = (globalObject, value, { context = "The provided value" } = {}) => {
      if (exports2.is(value)) {
        return utils.implForWrapper(value);
      }
      throw new globalObject.TypeError(`${context} is not of type 'DOMException'.`);
    };
    function makeWrapper(globalObject, newTarget) {
      let proto;
      if (newTarget !== void 0) {
        proto = newTarget.prototype;
      }
      if (!utils.isObject(proto)) {
        proto = globalObject[ctorRegistrySymbol]["DOMException"].prototype;
      }
      return Object.create(proto);
    }
    exports2.create = (globalObject, constructorArgs, privateData) => {
      const wrapper = makeWrapper(globalObject);
      return exports2.setup(wrapper, globalObject, constructorArgs, privateData);
    };
    exports2.createImpl = (globalObject, constructorArgs, privateData) => {
      const wrapper = exports2.create(globalObject, constructorArgs, privateData);
      return utils.implForWrapper(wrapper);
    };
    exports2._internalSetup = (wrapper, globalObject) => {
    };
    exports2.setup = (wrapper, globalObject, constructorArgs = [], privateData = {}) => {
      privateData.wrapper = wrapper;
      exports2._internalSetup(wrapper, globalObject);
      Object.defineProperty(wrapper, implSymbol, {
        value: new Impl.implementation(globalObject, constructorArgs, privateData),
        configurable: true
      });
      wrapper[implSymbol][utils.wrapperSymbol] = wrapper;
      if (Impl.init) {
        Impl.init(wrapper[implSymbol]);
      }
      return wrapper;
    };
    exports2.new = (globalObject, newTarget) => {
      const wrapper = makeWrapper(globalObject, newTarget);
      exports2._internalSetup(wrapper, globalObject);
      Object.defineProperty(wrapper, implSymbol, {
        value: Object.create(Impl.implementation.prototype),
        configurable: true
      });
      wrapper[implSymbol][utils.wrapperSymbol] = wrapper;
      if (Impl.init) {
        Impl.init(wrapper[implSymbol]);
      }
      return wrapper[implSymbol];
    };
    var exposed = /* @__PURE__ */ new Set(["Window", "Worker"]);
    exports2.install = (globalObject, globalNames) => {
      if (!globalNames.some((globalName) => exposed.has(globalName))) {
        return;
      }
      const ctorRegistry = utils.initCtorRegistry(globalObject);
      class DOMException {
        constructor() {
          const args = [];
          {
            let curArg = arguments[0];
            if (curArg !== void 0) {
              curArg = conversions["DOMString"](curArg, {
                context: "Failed to construct 'DOMException': parameter 1",
                globals: globalObject
              });
            } else {
              curArg = "";
            }
            args.push(curArg);
          }
          {
            let curArg = arguments[1];
            if (curArg !== void 0) {
              curArg = conversions["DOMString"](curArg, {
                context: "Failed to construct 'DOMException': parameter 2",
                globals: globalObject
              });
            } else {
              curArg = "Error";
            }
            args.push(curArg);
          }
          return exports2.setup(Object.create(new.target.prototype), globalObject, args);
        }
        get name() {
          const esValue = this !== null && this !== void 0 ? this : globalObject;
          if (!exports2.is(esValue)) {
            throw new globalObject.TypeError(
              "'get name' called on an object that is not a valid instance of DOMException."
            );
          }
          return esValue[implSymbol]["name"];
        }
        get message() {
          const esValue = this !== null && this !== void 0 ? this : globalObject;
          if (!exports2.is(esValue)) {
            throw new globalObject.TypeError(
              "'get message' called on an object that is not a valid instance of DOMException."
            );
          }
          return esValue[implSymbol]["message"];
        }
        get code() {
          const esValue = this !== null && this !== void 0 ? this : globalObject;
          if (!exports2.is(esValue)) {
            throw new globalObject.TypeError(
              "'get code' called on an object that is not a valid instance of DOMException."
            );
          }
          return esValue[implSymbol]["code"];
        }
      }
      Object.defineProperties(DOMException.prototype, {
        name: { enumerable: true },
        message: { enumerable: true },
        code: { enumerable: true },
        [Symbol.toStringTag]: { value: "DOMException", configurable: true },
        INDEX_SIZE_ERR: { value: 1, enumerable: true },
        DOMSTRING_SIZE_ERR: { value: 2, enumerable: true },
        HIERARCHY_REQUEST_ERR: { value: 3, enumerable: true },
        WRONG_DOCUMENT_ERR: { value: 4, enumerable: true },
        INVALID_CHARACTER_ERR: { value: 5, enumerable: true },
        NO_DATA_ALLOWED_ERR: { value: 6, enumerable: true },
        NO_MODIFICATION_ALLOWED_ERR: { value: 7, enumerable: true },
        NOT_FOUND_ERR: { value: 8, enumerable: true },
        NOT_SUPPORTED_ERR: { value: 9, enumerable: true },
        INUSE_ATTRIBUTE_ERR: { value: 10, enumerable: true },
        INVALID_STATE_ERR: { value: 11, enumerable: true },
        SYNTAX_ERR: { value: 12, enumerable: true },
        INVALID_MODIFICATION_ERR: { value: 13, enumerable: true },
        NAMESPACE_ERR: { value: 14, enumerable: true },
        INVALID_ACCESS_ERR: { value: 15, enumerable: true },
        VALIDATION_ERR: { value: 16, enumerable: true },
        TYPE_MISMATCH_ERR: { value: 17, enumerable: true },
        SECURITY_ERR: { value: 18, enumerable: true },
        NETWORK_ERR: { value: 19, enumerable: true },
        ABORT_ERR: { value: 20, enumerable: true },
        URL_MISMATCH_ERR: { value: 21, enumerable: true },
        QUOTA_EXCEEDED_ERR: { value: 22, enumerable: true },
        TIMEOUT_ERR: { value: 23, enumerable: true },
        INVALID_NODE_TYPE_ERR: { value: 24, enumerable: true },
        DATA_CLONE_ERR: { value: 25, enumerable: true }
      });
      Object.defineProperties(DOMException, {
        INDEX_SIZE_ERR: { value: 1, enumerable: true },
        DOMSTRING_SIZE_ERR: { value: 2, enumerable: true },
        HIERARCHY_REQUEST_ERR: { value: 3, enumerable: true },
        WRONG_DOCUMENT_ERR: { value: 4, enumerable: true },
        INVALID_CHARACTER_ERR: { value: 5, enumerable: true },
        NO_DATA_ALLOWED_ERR: { value: 6, enumerable: true },
        NO_MODIFICATION_ALLOWED_ERR: { value: 7, enumerable: true },
        NOT_FOUND_ERR: { value: 8, enumerable: true },
        NOT_SUPPORTED_ERR: { value: 9, enumerable: true },
        INUSE_ATTRIBUTE_ERR: { value: 10, enumerable: true },
        INVALID_STATE_ERR: { value: 11, enumerable: true },
        SYNTAX_ERR: { value: 12, enumerable: true },
        INVALID_MODIFICATION_ERR: { value: 13, enumerable: true },
        NAMESPACE_ERR: { value: 14, enumerable: true },
        INVALID_ACCESS_ERR: { value: 15, enumerable: true },
        VALIDATION_ERR: { value: 16, enumerable: true },
        TYPE_MISMATCH_ERR: { value: 17, enumerable: true },
        SECURITY_ERR: { value: 18, enumerable: true },
        NETWORK_ERR: { value: 19, enumerable: true },
        ABORT_ERR: { value: 20, enumerable: true },
        URL_MISMATCH_ERR: { value: 21, enumerable: true },
        QUOTA_EXCEEDED_ERR: { value: 22, enumerable: true },
        TIMEOUT_ERR: { value: 23, enumerable: true },
        INVALID_NODE_TYPE_ERR: { value: 24, enumerable: true },
        DATA_CLONE_ERR: { value: 25, enumerable: true }
      });
      ctorRegistry[interfaceName] = DOMException;
      Object.defineProperty(globalObject, interfaceName, {
        configurable: true,
        writable: true,
        value: DOMException
      });
    };
    var Impl = require_DOMException_impl();
  }
});

// ../node_modules/.pnpm/domexception@4.0.0/node_modules/domexception/webidl2js-wrapper.js
var require_webidl2js_wrapper = __commonJS({
  "../node_modules/.pnpm/domexception@4.0.0/node_modules/domexception/webidl2js-wrapper.js"(exports2, module2) {
    "use strict";
    var DOMException = require_DOMException();
    function installOverride(globalObject, globalNames) {
      if (typeof globalObject.Error !== "function") {
        throw new Error("Internal error: Error constructor is not present on the given global object.");
      }
      DOMException.install(globalObject, globalNames);
      Object.setPrototypeOf(globalObject.DOMException.prototype, globalObject.Error.prototype);
    }
    module2.exports = { ...DOMException, install: installOverride };
  }
});

// ../node_modules/.pnpm/domexception@4.0.0/node_modules/domexception/index.js
var require_domexception = __commonJS({
  "../node_modules/.pnpm/domexception@4.0.0/node_modules/domexception/index.js"(exports2, module2) {
    "use strict";
    var DOMException = require_webidl2js_wrapper();
    var sharedGlobalObject = { Array, Error, Object, Promise, String, TypeError };
    DOMException.install(sharedGlobalObject, ["Window"]);
    module2.exports = sharedGlobalObject.DOMException;
  }
});

// ../node_modules/.pnpm/@roamhq+wrtc@0.10.0/node_modules/@roamhq/wrtc/lib/datachannelevent.js
var require_datachannelevent = __commonJS({
  "../node_modules/.pnpm/@roamhq+wrtc@0.10.0/node_modules/@roamhq/wrtc/lib/datachannelevent.js"(exports2, module2) {
    "use strict";
    function RTCDataChannelEvent(type, eventInitDict) {
      Object.defineProperties(this, {
        bubbles: {
          value: false
        },
        cancelable: {
          value: false
        },
        type: {
          value: type,
          enumerable: true
        },
        channel: {
          value: eventInitDict.channel,
          enumerable: true
        },
        target: {
          value: eventInitDict.target,
          enumerable: true
        }
      });
    }
    module2.exports = RTCDataChannelEvent;
  }
});

// ../node_modules/.pnpm/@roamhq+wrtc@0.10.0/node_modules/@roamhq/wrtc/lib/icecandidate.js
var require_icecandidate = __commonJS({
  "../node_modules/.pnpm/@roamhq+wrtc@0.10.0/node_modules/@roamhq/wrtc/lib/icecandidate.js"(exports2, module2) {
    "use strict";
    function RTCIceCandidate3(candidateInitDict) {
      [
        "candidate",
        "sdpMid",
        "sdpMLineIndex",
        "foundation",
        "component",
        "priority",
        "address",
        "protocol",
        "port",
        "type",
        "tcpType",
        "relatedAddress",
        "relatedPort",
        "usernameFragment"
      ].forEach((property) => {
        if (candidateInitDict && property in candidateInitDict) {
          this[property] = candidateInitDict[property];
        } else {
          this[property] = null;
        }
      });
      this.toJSON = () => {
        const { candidate, sdpMid, sdpMLineIndex, usernameFragment } = this;
        let json = {
          candidate,
          sdpMid,
          sdpMLineIndex
        };
        if (usernameFragment) {
          json.usernameFragment = usernameFragment;
        }
        return json;
      };
    }
    module2.exports = RTCIceCandidate3;
  }
});

// ../node_modules/.pnpm/@roamhq+wrtc@0.10.0/node_modules/@roamhq/wrtc/lib/rtcpeerconnectioniceevent.js
var require_rtcpeerconnectioniceevent = __commonJS({
  "../node_modules/.pnpm/@roamhq+wrtc@0.10.0/node_modules/@roamhq/wrtc/lib/rtcpeerconnectioniceevent.js"(exports2, module2) {
    "use strict";
    function RTCPeerConnectionIceEvent(type, eventInitDict) {
      Object.defineProperties(this, {
        type: {
          value: type,
          enumerable: true
        },
        candidate: {
          value: eventInitDict.candidate,
          enumerable: true
        },
        target: {
          value: eventInitDict.target,
          enumerable: true
        }
      });
    }
    module2.exports = RTCPeerConnectionIceEvent;
  }
});

// ../node_modules/.pnpm/@roamhq+wrtc@0.10.0/node_modules/@roamhq/wrtc/lib/rtcpeerconnectioniceerrorevent.js
var require_rtcpeerconnectioniceerrorevent = __commonJS({
  "../node_modules/.pnpm/@roamhq+wrtc@0.10.0/node_modules/@roamhq/wrtc/lib/rtcpeerconnectioniceerrorevent.js"(exports2, module2) {
    "use strict";
    function RTCPeerConnectionIceErrorEvent(type, eventInitDict) {
      Object.defineProperties(this, {
        type: {
          value: type,
          enumerable: true
        },
        address: {
          value: eventInitDict.address,
          enumerable: true
        },
        port: {
          value: eventInitDict.port,
          enumerable: true
        },
        url: {
          value: eventInitDict.url,
          enumerable: true
        },
        errorCode: {
          value: eventInitDict.errorCode,
          enumerable: true
        },
        errorText: {
          value: eventInitDict.errorText,
          enumerable: true
        },
        target: {
          value: eventInitDict.target,
          enumerable: true
        }
      });
    }
    module2.exports = RTCPeerConnectionIceErrorEvent;
  }
});

// ../node_modules/.pnpm/@roamhq+wrtc@0.10.0/node_modules/@roamhq/wrtc/lib/sessiondescription.js
var require_sessiondescription = __commonJS({
  "../node_modules/.pnpm/@roamhq+wrtc@0.10.0/node_modules/@roamhq/wrtc/lib/sessiondescription.js"(exports2, module2) {
    "use strict";
    function RTCSessionDescription3(descriptionInitDict) {
      if (descriptionInitDict) {
        this.type = descriptionInitDict.type;
        this.sdp = descriptionInitDict.sdp;
      }
      this.toJSON = () => {
        const { sdp, type } = this;
        return {
          sdp,
          type
        };
      };
    }
    module2.exports = RTCSessionDescription3;
  }
});

// ../node_modules/.pnpm/@roamhq+wrtc@0.10.0/node_modules/@roamhq/wrtc/lib/peerconnection.js
var require_peerconnection = __commonJS({
  "../node_modules/.pnpm/@roamhq+wrtc@0.10.0/node_modules/@roamhq/wrtc/lib/peerconnection.js"(exports2, module2) {
    "use strict";
    var inherits = require("util").inherits;
    var _webrtc = require_binding();
    var EventTarget = require_eventtarget();
    var RTCDataChannelEvent = require_datachannelevent();
    var RTCIceCandidate3 = require_icecandidate();
    var RTCPeerConnectionIceEvent = require_rtcpeerconnectioniceevent();
    var RTCPeerConnectionIceErrorEvent = require_rtcpeerconnectioniceerrorevent();
    var RTCSessionDescription3 = require_sessiondescription();
    function RTCPeerConnection3() {
      var self = this;
      var pc = new _webrtc.RTCPeerConnection(arguments[0] || {});
      EventTarget.call(this);
      pc.ontrack = function ontrack(receiver, streams, transceiver) {
        self.dispatchEvent({
          type: "track",
          track: receiver.track,
          receiver,
          streams,
          transceiver,
          target: self
        });
      };
      pc.onconnectionstatechange = function onconnectionstatechange() {
        self.dispatchEvent({ type: "connectionstatechange", target: self });
      };
      pc.onicecandidate = function onicecandidate(candidate) {
        var icecandidate = new RTCIceCandidate3(candidate);
        self.dispatchEvent(
          new RTCPeerConnectionIceEvent("icecandidate", {
            candidate: icecandidate,
            target: self
          })
        );
      };
      pc.onicecandidateerror = function onicecandidateerror(eventInitDict) {
        eventInitDict.target = self;
        var icecandidateerror = new RTCPeerConnectionIceErrorEvent(
          "icecandidateerror",
          eventInitDict
        );
        self.dispatchEvent(icecandidateerror);
      };
      pc.onsignalingstatechange = function onsignalingstatechange() {
        self.dispatchEvent({ type: "signalingstatechange", target: self });
      };
      pc.oniceconnectionstatechange = function oniceconnectionstatechange() {
        self.dispatchEvent({ type: "iceconnectionstatechange", target: self });
      };
      pc.onicegatheringstatechange = function onicegatheringstatechange() {
        self.dispatchEvent({ type: "icegatheringstatechange", target: self });
        if (self.iceGatheringState === "complete" && self.connectionState !== "closed") {
          self.dispatchEvent(
            new RTCPeerConnectionIceEvent("icecandidate", {
              candidate: null,
              target: self
            })
          );
        }
      };
      pc.onnegotiationneeded = function onnegotiationneeded() {
        self.dispatchEvent({ type: "negotiationneeded", target: self });
      };
      pc.ondatachannel = function ondatachannel(channel) {
        self.dispatchEvent(
          new RTCDataChannelEvent("datachannel", { channel, target: self })
        );
      };
      Object.defineProperties(this, {
        _pc: {
          value: pc
        },
        canTrickleIceCandidates: {
          get: function getCanTrickleIceCandidates() {
            return pc.canTrickleIceCandidates;
          },
          enumerable: true
        },
        connectionState: {
          get: function getConnectionState() {
            return pc.connectionState;
          },
          enumerable: true
        },
        currentLocalDescription: {
          get: function getCurrentLocalDescription() {
            return pc.currentLocalDescription ? new RTCSessionDescription3(pc.currentLocalDescription) : null;
          },
          enumerable: true
        },
        localDescription: {
          get: function getLocalDescription() {
            return pc.localDescription ? new RTCSessionDescription3(pc.localDescription) : null;
          },
          enumerable: true
        },
        pendingLocalDescription: {
          get: function getPendingLocalDescription() {
            return pc.pendingLocalDescription ? new RTCSessionDescription3(pc.pendingLocalDescription) : null;
          },
          enumerable: true
        },
        currentRemoteDescription: {
          get: function getCurrentRemoteDescription() {
            return pc.currentRemoteDescription ? new RTCSessionDescription3(pc.currentRemoteDescription) : null;
          },
          enumerable: true
        },
        remoteDescription: {
          get: function getRemoteDescription() {
            return pc.remoteDescription ? new RTCSessionDescription3(pc.remoteDescription) : null;
          },
          enumerable: true
        },
        pendingRemoteDescription: {
          get: function getPendingRemoteDescription() {
            return pc.pendingRemoteDescription ? new RTCSessionDescription3(pc.pendingRemoteDescription) : null;
          },
          enumerable: true
        },
        signalingState: {
          get: function getSignalingState() {
            return pc.signalingState;
          },
          enumerable: true
        },
        sctp: {
          get: function() {
            return pc.sctp;
          },
          enumerable: true
        },
        iceGatheringState: {
          get: function getIceGatheringState() {
            return pc.iceGatheringState;
          },
          enumerable: true
        },
        iceConnectionState: {
          get: function getIceConnectionState() {
            return pc.iceConnectionState;
          },
          enumerable: true
        },
        onconnectionstatechange: {
          value: null,
          writable: true,
          enumerable: true
        },
        ondatachannel: {
          value: null,
          writable: true,
          enumerable: true
        },
        oniceconnectionstatechange: {
          value: null,
          writable: true,
          enumerable: true
        },
        onicegatheringstatechange: {
          value: null,
          writable: true,
          enumerable: true
        },
        onnegotiationneeded: {
          value: null,
          writable: true,
          enumerable: true
        },
        onsignalingstatechange: {
          value: null,
          writable: true,
          enumerable: true
        }
      });
    }
    inherits(RTCPeerConnection3, EventTarget);
    RTCPeerConnection3.prototype.ontrack = null;
    RTCPeerConnection3.prototype.addIceCandidate = function addIceCandidate(candidate) {
      if (!candidate?.candidate) {
        candidate = void 0;
      }
      var promise = this._pc.addIceCandidate(candidate);
      if (arguments.length === 3) {
        promise.then(arguments[1], arguments[2]);
      }
      return promise;
    };
    RTCPeerConnection3.prototype.addTransceiver = function addTransceiver() {
      return this._pc.addTransceiver.apply(this._pc, arguments);
    };
    RTCPeerConnection3.prototype.addTrack = function addTrack(track, ...streams) {
      return this._pc.addTrack(track, streams);
    };
    RTCPeerConnection3.prototype.close = function close() {
      this._pc.close();
    };
    RTCPeerConnection3.prototype.createDataChannel = function createDataChannel() {
      return this._pc.createDataChannel.apply(this._pc, arguments);
    };
    RTCPeerConnection3.prototype.createOffer = function createOffer() {
      var options = arguments.length === 3 ? arguments[2] : arguments[0];
      var promise = this._pc.createOffer(options || {});
      if (arguments.length >= 2) {
        promise.then(arguments[0], arguments[1]);
      }
      return promise;
    };
    RTCPeerConnection3.prototype.createAnswer = function createAnswer() {
      var options = arguments.length === 3 ? arguments[2] : arguments[0];
      var promise = this._pc.createAnswer(options || {});
      if (arguments.length >= 2) {
        promise.then(arguments[0], arguments[1]);
      }
      return promise;
    };
    RTCPeerConnection3.prototype.getConfiguration = function getConfiguration() {
      return this._pc.getConfiguration();
    };
    RTCPeerConnection3.prototype.getReceivers = function getReceivers() {
      return this._pc.getReceivers();
    };
    RTCPeerConnection3.prototype.getSenders = function getSenders() {
      return this._pc.getSenders();
    };
    RTCPeerConnection3.prototype.getTransceivers = function getTransceivers() {
      return this._pc.getTransceivers();
    };
    RTCPeerConnection3.prototype.getStats = function getStats() {
      return this._pc.getStats(arguments[0]);
    };
    RTCPeerConnection3.prototype.removeTrack = function removeTrack(sender) {
      this._pc.removeTrack(sender);
    };
    RTCPeerConnection3.prototype.setConfiguration = function setConfiguration(configuration) {
      return this._pc.setConfiguration(configuration);
    };
    RTCPeerConnection3.prototype.setLocalDescription = function setLocalDescription(description) {
      var promise = this._pc.setLocalDescription(description);
      if (arguments.length === 3) {
        promise.then(arguments[1], arguments[2]);
      }
      return promise;
    };
    RTCPeerConnection3.prototype.setRemoteDescription = function setRemoteDescription(description) {
      var promise = this._pc.setRemoteDescription(description);
      if (arguments.length === 3) {
        promise.then(arguments[1], arguments[2]);
      }
      return promise;
    };
    RTCPeerConnection3.prototype.restartIce = function restartIce() {
      return this._pc.restartIce();
    };
    module2.exports = RTCPeerConnection3;
  }
});

// ../node_modules/.pnpm/@roamhq+wrtc@0.10.0/node_modules/@roamhq/wrtc/lib/index.js
var require_lib2 = __commonJS({
  "../node_modules/.pnpm/@roamhq+wrtc@0.10.0/node_modules/@roamhq/wrtc/lib/index.js"(exports2, module2) {
    "use strict";
    var { inherits } = require("util");
    var {
      MediaStream,
      MediaStreamTrack,
      RTCAudioSink,
      RTCAudioSource,
      RTCDataChannel,
      RTCDtlsTransport,
      RTCIceTransport,
      RTCRtpReceiver,
      RTCRtpSender,
      RTCRtpTransceiver,
      RTCSctpTransport,
      RTCVideoSink,
      RTCVideoSource,
      getUserMedia,
      i420ToRgba,
      rgbaToI420,
      setDOMException
    } = require_binding();
    var EventTarget = require_eventtarget();
    var MediaDevices = require_mediadevices();
    inherits(MediaStream, EventTarget);
    inherits(MediaStreamTrack, EventTarget);
    inherits(RTCAudioSink, EventTarget);
    inherits(RTCDataChannel, EventTarget);
    inherits(RTCDtlsTransport, EventTarget);
    inherits(RTCIceTransport, EventTarget);
    inherits(RTCSctpTransport, EventTarget);
    inherits(RTCVideoSink, EventTarget);
    try {
      setDOMException(require_domexception());
    } catch (error) {
      void error;
    }
    RTCDataChannel.prototype.send = function send(data) {
      const implSymbol = Object.getOwnPropertySymbols(data).find(
        (symbol) => symbol.toString() === "Symbol(impl)"
      );
      if (data[implSymbol] && data[implSymbol]._buffer) {
        data = data[implSymbol]._buffer;
      }
      this._send(data);
    };
    var mediaDevices = new MediaDevices();
    var nonstandard2 = {
      i420ToRgba,
      RTCAudioSink,
      RTCAudioSource,
      RTCVideoSink,
      RTCVideoSource,
      rgbaToI420
    };
    module2.exports = {
      MediaStream,
      MediaStreamTrack,
      RTCDataChannel,
      RTCDataChannelEvent: require_datachannelevent(),
      RTCDtlsTransport,
      RTCIceCandidate: require_icecandidate(),
      RTCIceTransport,
      RTCPeerConnection: require_peerconnection(),
      RTCPeerConnectionIceEvent: require_rtcpeerconnectioniceevent(),
      RTCPeerConnectionIceErrorEvent: require_rtcpeerconnectioniceerrorevent(),
      RTCRtpReceiver,
      RTCRtpSender,
      RTCRtpTransceiver,
      RTCSctpTransport,
      RTCSessionDescription: require_sessiondescription(),
      getUserMedia,
      mediaDevices,
      nonstandard: nonstandard2
    };
  }
});

// ../node_modules/.pnpm/ws@8.20.0/node_modules/ws/wrapper.mjs
var import_stream = __toESM(require_stream(), 1);
var import_extension = __toESM(require_extension(), 1);
var import_permessage_deflate = __toESM(require_permessage_deflate(), 1);
var import_receiver = __toESM(require_receiver(), 1);
var import_sender = __toESM(require_sender(), 1);
var import_subprotocol = __toESM(require_subprotocol(), 1);
var import_websocket = __toESM(require_websocket(), 1);
var import_websocket_server = __toESM(require_websocket_server(), 1);

// src/server/server.ts
var import_http = require("http");
var import_path6 = require("path");
var import_os4 = require("os");

// src/lib/mobile-config.ts
var MOBILE_BRIDGE_CONFIG = {
  defaultBridgePort: 3333,
  daemonHost: "0.0.0.0",
  defaultTerminalCacheLines: 1e3
};
var DEFAULT_BRIDGE_PORT = MOBILE_BRIDGE_CONFIG.defaultBridgePort;
var DEFAULT_DAEMON_HOST = MOBILE_BRIDGE_CONFIG.daemonHost;
var DEFAULT_DAEMON_PORT = MOBILE_BRIDGE_CONFIG.defaultBridgePort;
var DEFAULT_TERMINAL_CACHE_LINES = MOBILE_BRIDGE_CONFIG.defaultTerminalCacheLines;
var WTERM_CONFIG_DISPLAY_PATH = "~/.zterm/config.json";
function buildDaemonSessionName(port = DEFAULT_DAEMON_PORT) {
  return `zterm-daemon-${port}`;
}
var DEFAULT_DAEMON_SESSION_NAME = buildDaemonSessionName();
var BRIDGE_URL_PLACEHOLDER = `ws://host:${DEFAULT_BRIDGE_PORT}`;

// src/server/daemon-config.ts
var import_fs = require("fs");
var import_os = require("os");
var import_path = require("path");
var import_crypto = require("crypto");
var DEFAULT_DAEMON_TERMINAL_CACHE_LINES = 3e3;
var WTERM_HOME_DIRNAME = ".zterm";
var LEGACY_WTERM_HOME_DIRNAME = ".wterm";
var WTERM_CONFIG_FILENAME = "config.json";
var WTERM_UPDATES_DIRNAME = "updates";
var WTERM_DAEMON_ID_FILENAME = "daemon-id";
function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}
function asPositiveInteger(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(1, Math.floor(value));
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) {
      return Math.max(1, parsed);
    }
  }
  return void 0;
}
function getWtermConfigPath(homeDir = (0, import_os.homedir)()) {
  return (0, import_path.join)(homeDir, WTERM_HOME_DIRNAME, WTERM_CONFIG_FILENAME);
}
function ensureZtermHomeDir(homeDir = (0, import_os.homedir)()) {
  const ztermHome = (0, import_path.join)(homeDir, WTERM_HOME_DIRNAME);
  if ((0, import_fs.existsSync)(ztermHome)) {
    return ztermHome;
  }
  const legacyHome = (0, import_path.join)(homeDir, LEGACY_WTERM_HOME_DIRNAME);
  if ((0, import_fs.existsSync)(legacyHome)) {
    (0, import_fs.renameSync)(legacyHome, ztermHome);
    return ztermHome;
  }
  (0, import_fs.mkdirSync)(ztermHome, { recursive: true });
  return ztermHome;
}
function getWtermHomeDir(homeDir = (0, import_os.homedir)()) {
  return ensureZtermHomeDir(homeDir);
}
function getWtermUpdatesDir(homeDir = (0, import_os.homedir)()) {
  return (0, import_path.join)(getWtermHomeDir(homeDir), WTERM_UPDATES_DIRNAME);
}
function getWtermDaemonIdPath(homeDir = (0, import_os.homedir)()) {
  return (0, import_path.join)(getWtermHomeDir(homeDir), WTERM_DAEMON_ID_FILENAME);
}
function sanitizeDaemonId(value) {
  return value.trim().replace(/[^a-zA-Z0-9._:-]/g, "-").slice(0, 128);
}
function buildDefaultDaemonId() {
  const host = (0, import_os.hostname)().trim() || "zterm-daemon";
  const entropy = (0, import_crypto.randomUUID)();
  const digest = (0, import_crypto.createHash)("sha256").update(`${host}:${entropy}`).digest("hex").slice(0, 16);
  return sanitizeDaemonId(`daemon-${host}-${digest}`);
}
function resolveStableDaemonHostId(homeDir = (0, import_os.homedir)()) {
  const daemonIdPath = getWtermDaemonIdPath(homeDir);
  if ((0, import_fs.existsSync)(daemonIdPath)) {
    const stored = sanitizeDaemonId((0, import_fs.readFileSync)(daemonIdPath, "utf-8"));
    if (stored) {
      return stored;
    }
  }
  const nextDaemonId = buildDefaultDaemonId();
  (0, import_fs.mkdirSync)(getWtermHomeDir(homeDir), { recursive: true });
  (0, import_fs.writeFileSync)(daemonIdPath, `${nextDaemonId}
`, "utf-8");
  return nextDaemonId;
}
function readWtermConfigFile(homeDir = (0, import_os.homedir)()) {
  const configPath = getWtermConfigPath(homeDir);
  if (!(0, import_fs.existsSync)(configPath)) {
    return {
      path: configPath,
      found: false,
      config: {}
    };
  }
  const raw = (0, import_fs.readFileSync)(configPath, "utf-8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in ${configPath}: ${message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid ${configPath}: root must be a JSON object`);
  }
  return {
    path: configPath,
    found: true,
    config: parsed
  };
}
function resolveDaemonRuntimeConfig(options) {
  const env = options?.env || process.env;
  const homeDir = options?.homeDir || (0, import_os.homedir)();
  const { config, found, path } = readWtermConfigFile(homeDir);
  const daemonConfig = config.zterm?.android?.daemon || config.mobile?.daemon || {};
  const relayConfig = config.zterm?.android?.relay || config.mobile?.relay || {};
  const host = asString(env.ZTERM_HOST) || asString(env.HOST) || asString(daemonConfig.host) || DEFAULT_DAEMON_HOST;
  const port = asPositiveInteger(env.ZTERM_PORT) || asPositiveInteger(env.PORT) || asPositiveInteger(daemonConfig.port) || DEFAULT_BRIDGE_PORT;
  const authTokenFromEnv = asString(env.ZTERM_AUTH_TOKEN);
  const authTokenFromConfig = asString(daemonConfig.authToken);
  const authToken = authTokenFromEnv || authTokenFromConfig || "";
  const authSource = authTokenFromEnv ? "env" : authTokenFromConfig ? "config" : "default";
  const terminalCacheLines = asPositiveInteger(env.ZTERM_TERMINAL_CACHE_LINES) || asPositiveInteger(daemonConfig.terminalCacheLines) || DEFAULT_DAEMON_TERMINAL_CACHE_LINES;
  const sessionName = asString(env.ZTERM_DAEMON_SESSION) || asString(daemonConfig.sessionName) || buildDaemonSessionName(port);
  const relayUrl = asString(env.ZTERM_TRAVERSAL_RELAY_URL) || asString(relayConfig.relayUrl);
  const relayUsername = asString(env.ZTERM_TRAVERSAL_USERNAME) || asString(relayConfig.username);
  const relayPassword = asString(env.ZTERM_TRAVERSAL_PASSWORD) || asString(relayConfig.password);
  const relayHostId = asString(env.ZTERM_TRAVERSAL_HOST_ID) || asString(relayConfig.hostId);
  const relayDefaultHostName = (0, import_os.hostname)().trim();
  const relayDeviceId = asString(env.ZTERM_TRAVERSAL_DEVICE_ID) || asString(relayConfig.deviceId) || relayDefaultHostName;
  const relayDeviceName = asString(env.ZTERM_TRAVERSAL_DEVICE_NAME) || asString(relayConfig.deviceName) || relayDefaultHostName;
  const relayPlatform = asString(env.ZTERM_TRAVERSAL_PLATFORM) || asString(relayConfig.platform) || process.platform;
  const relayAppVersion = asString(env.ZTERM_TRAVERSAL_APP_VERSION) || asString(env.ZTERM_APP_VERSION) || asString(relayConfig.appVersion);
  const relayDaemonVersion = asString(env.ZTERM_TRAVERSAL_DAEMON_VERSION) || asString(env.ZTERM_DAEMON_VERSION) || asString(relayConfig.daemonVersion) || relayAppVersion;
  const relay = relayUrl && relayUsername && relayPassword && relayHostId ? {
    relayUrl,
    username: relayUsername,
    password: relayPassword,
    hostId: relayHostId,
    deviceId: relayDeviceId,
    deviceName: relayDeviceName,
    platform: relayPlatform,
    appVersion: relayAppVersion,
    daemonVersion: relayDaemonVersion
  } : null;
  const daemonHostId = relay?.hostId || resolveStableDaemonHostId(homeDir);
  return {
    host,
    port,
    authToken,
    terminalCacheLines,
    sessionName,
    daemonHostId,
    configPath: path,
    configFound: found,
    authSource,
    relay
  };
}

// src/server/relay-client.ts
function asString2(value) {
  return typeof value === "string" ? value.trim() : "";
}
function withTrailingSlash(url) {
  if (!url.pathname.endsWith("/")) {
    url.pathname = `${url.pathname}/`;
  }
  return url;
}
function buildHttpUrl(base, relativePath) {
  const normalized = withTrailingSlash(new URL(base));
  return new URL(relativePath, normalized);
}
function buildWsUrl(base, relativePath) {
  const url = buildHttpUrl(base, relativePath);
  if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol === "https:") {
    url.protocol = "wss:";
  }
  return url;
}
function buildRelayEndpointCandidates(config, now) {
  return [
    {
      id: `relay-rtc:${config.hostId}`,
      kind: "relay-rtc",
      relayHostId: config.hostId,
      authRequired: true,
      lastSeenAt: now
    }
  ];
}
function buildRelayTmuxSessionSnapshots(sessionNames, now) {
  const seen = /* @__PURE__ */ new Set();
  const sessions2 = [];
  for (const rawName of sessionNames) {
    const name = typeof rawName === "string" ? rawName.trim() : "";
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    sessions2.push({
      name,
      updatedAt: now
    });
  }
  return sessions2;
}
function buildRelayDirectoryUpdateEnvelope(options) {
  return {
    type: "directory-update",
    directory: {
      endpoints: buildRelayEndpointCandidates(options.config, options.now),
      sessions: buildRelayTmuxSessionSnapshots(options.sessionNames, options.now),
      publishedAt: options.now
    }
  };
}
function publishRelayDirectoryUpdate(options) {
  try {
    const now = options.now();
    const envelope = buildRelayDirectoryUpdateEnvelope({
      config: options.config,
      sessionNames: options.listTmuxSessions(),
      now
    });
    if (options.socket.readyState === import_websocket.default.OPEN) {
      options.socket.send(JSON.stringify(envelope));
    }
    return { ok: true, envelope };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (options.socket.readyState === import_websocket.default.OPEN) {
      options.socket.send(JSON.stringify({
        type: "relay-error",
        reason: `directory-update failed: ${reason}`
      }));
    }
    return { ok: false, reason };
  }
}
async function login(config) {
  const loginUrl = buildHttpUrl(config.relayUrl, "api/auth/login");
  const response = await fetch(loginUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      username: config.username,
      password: config.password
    })
  });
  if (!response.ok) {
    throw new Error(`relay login failed: HTTP ${response.status}`);
  }
  const payload = await response.json();
  const accessToken = asString2(payload.accessToken);
  if (!accessToken) {
    throw new Error("relay login response missing accessToken");
  }
  return accessToken;
}
function createTraversalRelayHostClient(options) {
  const config = options.config;
  let socket = null;
  let reconnectTimer = null;
  let disposed = false;
  function clearReconnectTimer() {
    if (!reconnectTimer) {
      return;
    }
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  function scheduleReconnect(delayMs) {
    if (disposed || !config) {
      return;
    }
    clearReconnectTimer();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delayMs);
    reconnectTimer.unref?.();
  }
  async function connect() {
    if (disposed || !config) {
      return;
    }
    try {
      const accessToken = await login(config);
      const wsUrl = buildWsUrl(config.relayUrl, "ws/host");
      wsUrl.searchParams.set("token", accessToken);
      wsUrl.searchParams.set("hostId", config.hostId);
      wsUrl.searchParams.set("deviceId", config.deviceId);
      if (config.deviceName) {
        wsUrl.searchParams.set("deviceName", config.deviceName);
      }
      if (config.platform) {
        wsUrl.searchParams.set("platform", config.platform);
      }
      if (config.appVersion) {
        wsUrl.searchParams.set("appVersion", config.appVersion);
      }
      if (config.daemonVersion) {
        wsUrl.searchParams.set("daemonVersion", config.daemonVersion);
      }
      const nextSocket = new import_websocket.default(wsUrl);
      socket = nextSocket;
      nextSocket.on("open", () => {
        console.log(`[${(/* @__PURE__ */ new Date()).toISOString()}] traversal relay host online: ${config.hostId} -> ${wsUrl.origin}`);
      });
      nextSocket.on("message", async (rawData) => {
        try {
          const envelope = JSON.parse(String(rawData));
          if (envelope.type === "relay-ready") {
            console.log(`[${(/* @__PURE__ */ new Date()).toISOString()}] traversal relay ready for host ${envelope.hostId || config.hostId}`);
            const publishResult = publishRelayDirectoryUpdate({
              socket: nextSocket,
              config,
              listTmuxSessions: options.listTmuxSessions,
              now: options.now || (() => (/* @__PURE__ */ new Date()).toISOString())
            });
            if (publishResult.ok) {
              console.log(
                `[${(/* @__PURE__ */ new Date()).toISOString()}] traversal relay directory published: host=${config.hostId} endpoints=${publishResult.envelope.directory?.endpoints?.length || 0} sessions=${publishResult.envelope.directory?.sessions?.length || 0}`
              );
            } else {
              console.warn(`[${(/* @__PURE__ */ new Date()).toISOString()}] traversal relay directory publish failed: ${publishResult.reason}`);
            }
            return;
          }
          if (envelope.type === "relay-peer-close" && envelope.peerId) {
            options.closeRelayPeer(envelope.peerId, envelope.reason || "relay peer closed");
            return;
          }
          if (envelope.type === "relay-signal" && envelope.peerId && envelope.message) {
            await options.handleRelaySignal(envelope.peerId, envelope.message, (message) => {
              if (nextSocket.readyState !== import_websocket.default.OPEN) {
                return;
              }
              nextSocket.send(JSON.stringify({
                type: "relay-signal",
                peerId: envelope.peerId,
                message
              }));
            });
            return;
          }
          if (envelope.type === "relay-error") {
            console.warn(`[${(/* @__PURE__ */ new Date()).toISOString()}] traversal relay host error: ${envelope.reason || "unknown error"}`);
          }
        } catch (error) {
          console.warn(`[${(/* @__PURE__ */ new Date()).toISOString()}] traversal relay host parse error: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
      nextSocket.on("close", (code, reasonBuffer) => {
        if (socket === nextSocket) {
          socket = null;
        }
        const reason = Buffer.isBuffer(reasonBuffer) ? reasonBuffer.toString("utf-8") : String(reasonBuffer || "");
        console.warn(`[${(/* @__PURE__ */ new Date()).toISOString()}] traversal relay host websocket closed (${code} ${reason})`);
        scheduleReconnect(2e3);
      });
      nextSocket.on("error", (error) => {
        console.warn(`[${(/* @__PURE__ */ new Date()).toISOString()}] traversal relay host websocket error: ${error.message}`);
      });
    } catch (error) {
      console.warn(`[${(/* @__PURE__ */ new Date()).toISOString()}] traversal relay host connect failed: ${error instanceof Error ? error.message : String(error)}`);
      scheduleReconnect(3e3);
    }
  }
  return {
    enabled: Boolean(config),
    start() {
      if (!config) {
        return;
      }
      void connect();
    },
    dispose() {
      disposed = true;
      clearReconnectTimer();
      if (socket && socket.readyState < import_websocket.default.CLOSING) {
        socket.close(1e3, "relay host client disposed");
      }
      socket = null;
    }
  };
}

// src/server/canonical-buffer.ts
var DEFAULT_COLOR = 256;
function rowsEqual(left, right) {
  if (!left || !right || left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (!a || !b) {
      return false;
    }
    if (a.char !== b.char || a.fg !== b.fg || a.bg !== b.bg || a.flags !== b.flags || a.width !== b.width) {
      return false;
    }
  }
  return true;
}
function trimCanonicalBufferWindow(bufferStartIndex, bufferLines, maxLines) {
  const safeMaxLines = Math.max(1, Math.floor(maxLines));
  if (bufferLines.length <= safeMaxLines) {
    return {
      startIndex: bufferStartIndex,
      lines: bufferLines
    };
  }
  const trimCount = bufferLines.length - safeMaxLines;
  return {
    startIndex: bufferStartIndex + trimCount,
    lines: bufferLines.slice(trimCount)
  };
}
function isTrailingDefaultBlankCell(cell) {
  return Boolean(
    cell && cell.width === 1 && cell.char === 32 && cell.fg === DEFAULT_COLOR && cell.bg === DEFAULT_COLOR && cell.flags === 0
  );
}
function trimTrailingDefaultCells(row) {
  let end = row.length;
  while (end > 0 && isTrailingDefaultBlankCell(row[end - 1])) {
    end -= 1;
  }
  return end === row.length ? row : row.slice(0, end);
}
function normalizeCapturedLineBlock(raw, expectedLineCount) {
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  if (typeof expectedLineCount === "number" && Number.isFinite(expectedLineCount)) {
    const targetCount = Math.max(0, Math.floor(expectedLineCount));
    let nextLines = lines;
    if (nextLines.length > targetCount && nextLines[nextLines.length - 1] === "") {
      nextLines = nextLines.slice(0, -1);
    }
    if (nextLines.length > targetCount) {
      nextLines = nextLines.slice(0, targetCount);
    }
    while (nextLines.length < targetCount) {
      nextLines = [...nextLines, ""];
    }
    return nextLines;
  }
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}
function normalizeMirrorCaptureLines(raw, options) {
  void options;
  return normalizeCapturedLineBlock(raw);
}
function toIndexedLines(startIndex, lines) {
  return lines.map((cells, offset) => ({
    index: startIndex + offset,
    cells
  }));
}
function sliceIndexedLines(bufferStartIndex, bufferLines, startIndex, endIndex) {
  const actualStart = Math.max(bufferStartIndex, Math.floor(startIndex));
  const actualEnd = Math.max(actualStart, Math.min(bufferStartIndex + bufferLines.length, Math.floor(endIndex)));
  const startOffset = actualStart - bufferStartIndex;
  const endOffset = actualEnd - bufferStartIndex;
  return toIndexedLines(actualStart, bufferLines.slice(startOffset, endOffset));
}
function findChangedIndexedRanges(options) {
  const nextEndIndex = options.nextStartIndex + options.nextLines.length;
  const changedRanges = [];
  let activeRangeStart = null;
  for (let index = options.nextStartIndex; index < nextEndIndex; index += 1) {
    const previousOffset = index - options.previousStartIndex;
    const nextOffset = index - options.nextStartIndex;
    const previousRow = previousOffset >= 0 && previousOffset < options.previousLines.length ? options.previousLines[previousOffset] : null;
    const nextRow = nextOffset >= 0 && nextOffset < options.nextLines.length ? options.nextLines[nextOffset] : null;
    if (!rowsEqual(previousRow, nextRow)) {
      if (activeRangeStart === null) {
        activeRangeStart = index;
      }
      continue;
    }
    if (activeRangeStart !== null) {
      changedRanges.push({
        startIndex: activeRangeStart,
        endIndex: index
      });
      activeRangeStart = null;
    }
  }
  if (activeRangeStart !== null) {
    changedRanges.push({
      startIndex: activeRangeStart,
      endIndex: nextEndIndex
    });
  }
  return changedRanges;
}
function resolveCanonicalAvailableLineCount(options) {
  return Math.max(
    Math.max(1, Math.floor(options.paneRows)),
    Math.max(0, Math.floor(options.tmuxAvailableLineCountHint)),
    Math.max(0, Math.floor(options.capturedLineCount)),
    Math.max(0, Math.floor(options.scratchLineCount))
  );
}

// src/server/buffer-sync-contract.ts
var DEFAULT_FG = 256;
var DEFAULT_BG = 256;
var DEFAULT_FLAGS = 0;
function compactLine(index, cells) {
  let text = "";
  let widths;
  let spans;
  let runStart = 0;
  let runFg = DEFAULT_FG;
  let runBg = DEFAULT_BG;
  let runFlags = DEFAULT_FLAGS;
  let hasNonDefault = false;
  let hasNonUnitWidth = false;
  let col = 0;
  let firstTextCell = true;
  let outputCol = 0;
  for (let c = 0; c < cells.length; c++) {
    const cell = cells[c];
    if (cell.width <= 0) continue;
    text += String.fromCodePoint(cell.char);
    if (widths || cell.width !== 1) {
      if (widths === void 0) {
        widths = new Array(Math.max(0, col)).fill(1);
      }
      widths.push(cell.width);
    }
    if (cell.width !== 1) hasNonUnitWidth = true;
    const isDefault = cell.fg === DEFAULT_FG && cell.bg === DEFAULT_BG && cell.flags === DEFAULT_FLAGS;
    if (!isDefault) hasNonDefault = true;
    if (firstTextCell) {
      runFg = cell.fg;
      runBg = cell.bg;
      runFlags = cell.flags;
      runStart = outputCol;
      firstTextCell = false;
    } else if (cell.fg !== runFg || cell.bg !== runBg || cell.flags !== runFlags) {
      if (spans === void 0) spans = [];
      spans.push([runStart, outputCol, runFg, runBg, runFlags]);
      runStart = outputCol;
      runFg = cell.fg;
      runBg = cell.bg;
      runFlags = cell.flags;
    }
    outputCol += cell.width;
    col++;
  }
  if (col > 0) {
    if (spans === void 0) spans = [];
    spans.push([runStart, outputCol, runFg, runBg, runFlags]);
  }
  const result = { i: index, t: text };
  if (hasNonUnitWidth && widths && widths.length > 0) {
    result.w = widths;
  }
  if (hasNonDefault && spans && spans.length > 0) {
    const nonDefaultSpans = spans.filter(
      ([, , fg, bg, flags]) => fg !== DEFAULT_FG || bg !== DEFAULT_BG || flags !== DEFAULT_FLAGS
    );
    if (nonDefaultSpans.length > 0) {
      result.s = nonDefaultSpans;
    }
  }
  return result;
}
function getMirrorAvailableEndIndex(mirror) {
  return mirror.bufferStartIndex + mirror.bufferLines.length;
}
function buildBufferHeadPayload(sessionId, mirror) {
  const availableStartIndex = Math.max(0, Math.floor(mirror.bufferStartIndex || 0));
  const availableEndIndex = Math.max(availableStartIndex, getMirrorAvailableEndIndex(mirror));
  return {
    sessionId,
    revision: Math.max(0, Math.floor(mirror.revision || 0)),
    latestEndIndex: availableEndIndex,
    availableStartIndex,
    availableEndIndex,
    cursorKeysApp: Boolean(mirror.cursorKeysApp),
    cursor: mirror.cursor
  };
}
function normalizeRequestedMissingRanges(missingRanges, startIndex, endIndex) {
  if (!Array.isArray(missingRanges) || endIndex <= startIndex) {
    return [];
  }
  return missingRanges.map((range) => ({
    startIndex: Math.max(startIndex, Math.min(endIndex, Math.floor(range?.startIndex || 0))),
    endIndex: Math.max(startIndex, Math.min(endIndex, Math.floor(range?.endIndex || 0)))
  })).filter((range) => range.endIndex > range.startIndex).sort((left, right) => left.startIndex - right.startIndex || left.endIndex - right.endIndex);
}
function buildBufferSyncPayload(mirror, requestStartIndex, requestEndIndex, lines) {
  const availableStartIndex = Math.max(0, Math.floor(mirror.bufferStartIndex || 0));
  const availableEndIndex = Math.max(availableStartIndex, getMirrorAvailableEndIndex(mirror));
  return {
    revision: Math.max(0, Math.floor(mirror.revision || 0)),
    startIndex: Math.max(0, Math.floor(requestStartIndex || 0)),
    endIndex: Math.max(0, Math.floor(requestEndIndex || 0)),
    availableStartIndex,
    availableEndIndex,
    cols: Math.max(1, Math.floor(mirror.cols || 80)),
    rows: Math.max(1, Math.floor(mirror.rows || 24)),
    cursorKeysApp: Boolean(mirror.cursorKeysApp),
    cursor: mirror.cursor,
    lines: lines.map((line) => compactLine(line.index, line.cells))
  };
}
function buildLiveTailBufferSyncPayload(mirror, options) {
  const availableStartIndex = Math.max(0, Math.floor(mirror.bufferStartIndex || 0));
  const availableEndIndex = Math.max(availableStartIndex, getMirrorAvailableEndIndex(mirror));
  const viewportRows = Math.max(1, Math.floor(options?.viewportRows || mirror.rows || 24));
  const requestEndIndex = availableEndIndex;
  const requestStartIndex = Math.max(availableStartIndex, requestEndIndex - viewportRows * 3);
  const indexedLines = sliceIndexedLines(
    mirror.bufferStartIndex,
    mirror.bufferLines,
    requestStartIndex,
    requestEndIndex
  );
  return buildBufferSyncPayload(mirror, requestStartIndex, requestEndIndex, indexedLines);
}
function buildChangedRangesBufferSyncPayload(mirror, changedRanges) {
  if (!Array.isArray(changedRanges) || changedRanges.length === 0) {
    return null;
  }
  const availableStartIndex = Math.max(0, Math.floor(mirror.bufferStartIndex || 0));
  const availableEndIndex = Math.max(availableStartIndex, getMirrorAvailableEndIndex(mirror));
  const normalizedRanges = changedRanges.map((range) => ({
    startIndex: Math.max(availableStartIndex, Math.min(availableEndIndex, Math.floor(range?.startIndex || 0))),
    endIndex: Math.max(availableStartIndex, Math.min(availableEndIndex, Math.floor(range?.endIndex || 0)))
  })).filter((range) => range.endIndex > range.startIndex).sort((left, right) => left.startIndex - right.startIndex || left.endIndex - right.endIndex);
  if (normalizedRanges.length === 0) {
    return null;
  }
  const requestStartIndex = normalizedRanges[0].startIndex;
  const requestEndIndex = normalizedRanges[normalizedRanges.length - 1].endIndex;
  const indexedLines = sliceIndexedLines(
    mirror.bufferStartIndex,
    mirror.bufferLines,
    requestStartIndex,
    requestEndIndex
  );
  return buildBufferSyncPayload(mirror, requestStartIndex, requestEndIndex, indexedLines);
}
function buildRequestedRangeBufferPayload(mirror, request) {
  const mirrorStartIndex = Math.max(0, Math.floor(mirror.bufferStartIndex || 0));
  const mirrorEndIndex = Math.max(mirrorStartIndex, getMirrorAvailableEndIndex(mirror));
  const requestStartIndex = Math.max(
    mirrorStartIndex,
    Math.min(
      mirrorEndIndex,
      Number.isFinite(request.requestStartIndex) ? Math.floor(request.requestStartIndex) : mirrorStartIndex
    )
  );
  const requestEndIndex = Math.max(
    requestStartIndex,
    Math.min(
      mirrorEndIndex,
      Number.isFinite(request.requestEndIndex) ? Math.floor(request.requestEndIndex) : requestStartIndex
    )
  );
  if (mirrorEndIndex <= mirrorStartIndex || requestEndIndex <= requestStartIndex) {
    return buildBufferSyncPayload(mirror, requestStartIndex, requestEndIndex, []);
  }
  const requestedMissingRanges = normalizeRequestedMissingRanges(
    request.missingRanges,
    requestStartIndex,
    requestEndIndex
  );
  const requestedSpan = requestedMissingRanges.length > 0 ? {
    startIndex: requestedMissingRanges[0].startIndex,
    endIndex: requestedMissingRanges[requestedMissingRanges.length - 1].endIndex
  } : { startIndex: requestStartIndex, endIndex: requestEndIndex };
  const indexedLines = sliceIndexedLines(
    mirror.bufferStartIndex,
    mirror.bufferLines,
    requestedSpan.startIndex,
    requestedSpan.endIndex
  );
  return buildBufferSyncPayload(mirror, requestedSpan.startIndex, requestedSpan.endIndex, indexedLines);
}

// src/server/mirror-geometry.ts
var DEFAULT_TERMINAL_SESSION_VIEWPORT = {
  cols: 80,
  rows: 24
};
function normalizeGeometry(geometry) {
  if (!geometry) {
    return null;
  }
  if (!Number.isFinite(geometry.cols) || !Number.isFinite(geometry.rows)) {
    return null;
  }
  const cols = Math.max(1, Math.floor(geometry.cols));
  const rows = Math.max(1, Math.floor(geometry.rows));
  return { cols, rows };
}
function resolveAttachGeometry(input) {
  const baseline = normalizeGeometry(input.currentMirrorGeometry) || normalizeGeometry(input.existingTmuxGeometry) || normalizeGeometry(input.previousSessionGeometry) || { ...DEFAULT_TERMINAL_SESSION_VIEWPORT };
  const requested = normalizeGeometry(input.requestedGeometry);
  return {
    cols: requested ? requested.cols : baseline.cols,
    rows: baseline.rows
  };
}

// ../node_modules/.pnpm/@jsonstudio+wtermmod-core@0.1.9/node_modules/@jsonstudio/wtermmod-core/dist/wasm-inline.js
var WASM_BASE64 = "AGFzbQEAAAABKQhgAAF/YAAAYAF/AX9gAX8AYAJ/fwBgA39/fwBgAn9/AX9gA39/fwF/AysqAAABAAACAgIAAAAAAAAAAAAAAAABAAADBAEBAQUFBAEFAwUFBgcFAAQEBAUBcAEBAQUDAQBYBgkBfwFBgIDAAAsHowMbBm1lbW9yeQIACmdldE1heENvbHMAAAtnZXRDZWxsU2l6ZQABDWNsZWFyUmVzcG9uc2UAAg5nZXRSZXNwb25zZUxlbgADDmdldFJlc3BvbnNlUHRyAAQUZ2V0U2Nyb2xsYmFja0xpbmVMZW4ABRFnZXRTY3JvbGxiYWNrTGluZQAHEmdldFNjcm9sbGJhY2tDb3VudAAID2dldFRpdGxlQ2hhbmdlZAAJC2dldFRpdGxlTGVuAAoLZ2V0VGl0bGVQdHIACxFnZXRVc2luZ0FsdFNjcmVlbgAMEWdldEJyYWNrZXRlZFBhc3RlAA0QZ2V0Q3Vyc29yS2V5c0FwcAAOB2dldFJvd3MADwdnZXRDb2xzABAQZ2V0Q3Vyc29yVmlzaWJsZQARDGdldEN1cnNvckNvbAASDGdldEN1cnNvclJvdwATCmNsZWFyRGlydHkAFAtnZXREaXJ0eVB0cgAVCmdldEdyaWRQdHIAFgp3cml0ZUJ5dGVzABcOZ2V0V3JpdGVCdWZmZXIAJw5yZXNpemVUZXJtaW5hbAAoBGluaXQAKQriYyoFAEGAAgsEAEEMCw0AQQBBADoAxonwgAALCwBBAC0AxonwgAALCABBhonwgAALGgACQCAAEIaAgIAAIgANAEEADwsgAC8BgBgLXAECf0EAIQECQCAAQQAoAuiCrIIAIgJPDQACQAJAIAJB6AdPDQAgAiAAQX9zaiEADAELQQAoAuyCrIIAIABrQecHakHoB3AhAAsgAEGEGGxByKPwgABqIQELIAELFQAgABCGgICAACIAQciL8IAAIAAbCwsAQQAoAuiCrIIACygBAX9BACEAAkBBAC0AhYnwgABFDQBBAEEAOgCFifCAAEEBIQALIAALCwBBAC8B3obwgAALCABBhIfwgAALCwBBAC0Ag4fwgAALCwBBAC0A+4bwgAALCwBBAC0A+obwgAALCwBBAC8B9IbwgAALCwBBAC8B+IbwgAALCwBBAC0AhInwgAALCwBBAC8B3IbwgAALCwBBAC8B2obwgAALNwECf0EALwGagPCAACEAQQAhAQJAA0AgACABRg0BIAFBnIDwgABqQQA6AAAgAUEBaiEBDAALCwsIAEGcgPCAAAsIAEGYgMCAAAueQwMFfwF+BX8jgICAgABB4ABrIgEkgICAgAAgAEGAwAAgAEGAwABJGyECQZyC8IAAQQJqIQNBACEAA0ACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAIAAgAkYNAAJAAkACQAJAAkACQAJAAkACQAJAAkAgAC0A8IKsggAiBEFoag4EAgECAAELQQAtAMKC8IAAIQRBAEECOgDCgvCAACAEQQdxQQdGDQNBAEEAOwHIgvCAAAwdCwJAAkACQAJAAkACQEEALQDCgvCAAEEHcQ4ICwABAgMEBQcLCyAEwEG/f0oNCUEALQDPhvCAAEEALQDOhvCAAGtBB3FByobwgABqIAQ6AABBAEEALQDOhvCAAEF/akEHcSIEOgDOhvCAACAEDSFB/f8DIQQCQAJAAkACQEEALQDPhvCAAEEHcUF+ag4DAAECAwtBAC0AyobwgABBH3FBBnRBAC0Ay4bwgABBP3FyIQQMAgtBAC0Ay4bwgABBP3FBBnRBAC0AyobwgABBD3FBDHRyQQAtAMyG8IAAQT9xciEEDAELQQAtAMuG8IAAQT9xQQx0QQAtAMqG8IAAQRJ0ckEALQDMhvCAAEE/cUEGdHJBAC0AzYbwgABBP3FyIQQLQQAgBDsBnILwgAAgAyAEQYCA/ABxQRB2OgAAQQBBADoAwoLwgAAMCwsCQAJAAkAgBEGlf2oOAwACAQILQQBBBDoAwoLwgABBAEEAOwHIgvCAAEEAQQA6AMWC8IAAQQBBADoAxILwgABBiIIwIQQDQCAEQaiCMEYNIyAEQZiAwIAAakEAOwEAIARBAmohBAwACwtBAEEHOgDCgvCAAEEAQQA7AcCC8IAADCELAkAgBEHwAXFBIEcNAAJAQQAtAMiC8IAAIgVBAUsNACAFIAQ6AMaC8IAAQQBBAC0AyILwgABBAWo6AMiC8IAAC0EAQQM6AMKC8IAADCELIARBUGpB/wFxQc8ASQ0PIARBIEkNGQwECwJAIARB8AFxQSBHDQBBAC0AyILwgAAiBUEBSw0gIAUgBDoAxoLwgABBAEEALQDIgvCAAEEBajoAyILwgAAMIAsgBEFQakH/AXFBzwBJDQ4gBEEgSQ0YDAMLAkACQAJAAkACQAJAIARBUGpB/wFxIgVBCUsNAEEALQDFgvCAAA0kQQAtAMSC8IAAIgQNAUEAIQRBAEEBOgDEgvCAAAwCCyAEQUVqDgUCBAQiIgMLIARBf2pB/wFxIQQLIARBAXQiBEF/IAQvAaCC8IAAQRB0rUIKfiIGpyAGQiCIpxtBEHYgBWoiBEH//wMgBEH//wNJGzsBoILwgAAMIQtBAC0AxILwgAAiBEEPSw0gQQAgBEEBIARBAUsbQQFqOgDEgvCAAAwgCyAEQSFGDR4LAkAgBEHwAXFBIEcNAAJAQQAtAMiC8IAAIgVBAUsNACAFIAQ6AMaC8IAAQQBBAC0AyILwgABBAWo6AMiC8IAAC0EAQQU6AMKC8IAADB8LIARBQGpB/wFxQT9JDQkgBEEgSQ0XDBwLAkAgBEHwAXFBIEcNAEEALQDIgvCAACIFQQFLDR4gBSAEOgDGgvCAAEEAQQAtAMiC8IAAQQFqOgDIgvCAAAweCyAEQUBqQf8BcUE/SQ0IIARBIE8NGwwWCyAEQUBqQf8BcUE+Sw0cC0EAQQA6AMKC8IAADBsLIARBB0cNAUEAQQA6AMKC8IAAC0EALwHAgvCAACIEQQJJDRlBAC0AyoLwgABBUGoOAwcZBxkLIARBYGpB/wFxQd4ASw0YQQAvAcCC8IAAIgVB/wNLDRggBSAEOgDKgvCAAEEAIAVBAWo7AcCC8IAADBgLQQBBADoAwoLwgAALIARBIEkNDwJAIARB/wBJDQACQCAEQf8ARw0AQQBB/wA6AMOC8IAADBILAkAgBEHgAXFBwAFHDQBBAEECOgDPhvCAAEEAIAQ6AMqG8IAAQQBBAToAzobwgABBAEEBOgDCgvCAAAwYCwJAIARB8AFxQeABRw0AQQBBAzoAz4bwgABBACAEOgDKhvCAAEEAQQI6AM6G8IAAQQBBAToAwoLwgAAMGAsgBEH4AXFB8AFHDRdBAEEEOgDPhvCAAEEAIAQ6AMqG8IAAQQBBAzoAzobwgABBAEEBOgDCgvCAAAwXC0EAIAQ7AZyC8IAAIANBADoAAAtBACgCnILwgAAhBUEALQCBh/CAAA0BDA0LQQAgBDoAw4LwgABBAEEAOgDCgvCAAEEALQDJgvCAACIFQT9HDQRBASEHAkACQCAEQZh/ag4FARYWFgAWC0EAIQcLQQAhBEEALQDEgvCAACIFQQEgBUEBSxtBAXQhCANAIAggBEYNFQJAAkACQAJAAkACQAJAAkACQAJAAkAgBEGggvCAAGovAQAiBUF/ag4HAQoKCgoCAwALAkAgBUHpd2oOAwYJBwALIAVBFEYNAyAFQRlGDQQgBUEvRg0FIAVB1A9GDQcMCQtBACAHOgD6hvCAAAwIC0EAIAc6AP2G8IAADAcLQQAgBzoA/obwgAAMBgtBACAHOgD8hvCAAAwFC0EAIAc6AISJ8IAADAQLIAdBABCYgICAAAwDCyAHQQEQmICAgAAMAgtBACAHOgD7hvCAAAwBCwJAIAcNABCZgICAAAwBCxCagICAAAsgBEECaiEEDAALC0EAQQA7AdyG8IAAEJuAgIAAQQBBADoAgYfwgAAMCwsgAUHgAGokgICAgAAPC0EALQDLgvCAAEE7Rw0RIARBfmoiBEGAAiAEQYACSRshBUEAIQQCQANAIAUgBEYNASAEQYSH8IAAaiAEQcyC8IAAai0AADoAACAEQQFqIQQMAAsLQQBBAToAhYnwgABBACAFOwHehvCAAAwRC0EAIAQ6AMOC8IAAQQBBADoAwoLwgAACQAJAAkACQAJAAkACQEEALQDIgvCAAEUNAEEALQDGgvCAAEH/AXFBI0cNAAJAIARBvH9qDgoDAhgYBxgYGBgEAAsCQCAEQUlqDgIKAAULQQAhBQJAA0AgBUH//wNxQQAvAfSG8IAATw0BQQAhBAJAA0AgBEH//wNxQQAvAfiG8IAATw0BIAUgBEGMgMCAABCcgICAACAEQQFqIQQMAAsLIAVBAWohBQwACwtBAEEANgHahvCAAAwXCwJAIARBvH9qDgoCARcXBhcXFxcDAAsCQCAEQUlqDgIJCAALIARB4wBGDQQMFgtBAEEAOgCBh/CAAEEAQQA7AdyG8IAACxCbgICAAAwUCwJAQQAvAdqG8IAAIgRBAC8B8obwgABHDQAgBEEALwHYhvCAAEEBEJ2AgIAADBQLIARFDRNBACAEQX9qOwHahvCAAAwTCyAEQeMARw0SC0EALwH4hvCAAEEALwH0hvCAABCegICAAAwRC0EALwHchvCAACIEQf8BSw0QIARBAToAx4nwgAAMEAsCQCAEQfAARw0AIAVBIUcNAEEAQQE6AP6G8IAAQQBBAToAhInwgABBAEGAgoAINgLshvCAAEEAQQAvAfSG8IAAOwHYhvCAAEEAQQA6AP2G8IAAQQBBADoA+4bwgABBAEEAOgD6hvCAAEEAQQA7AfKG8IAAQQBBADoA/4bwgAAMEAsCQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAIARBQGoONhgAAQIDBAUGFiMHCAkKIyMLIyMMDSMjIw4jIyMjIyMjFw8jIxARFhIjIyMjIxMaIyMjGRUjFCMLQQBBAEEALwHahvCAACIEQQAvAaCC8IAAIgVBASAFQQFLG0EBQQAtAMSC8IAAG2siBSAFIARLGzsB2obwgABBAEEAOgCBh/CAAAwiC0EAQQAvAdqG8IAAQQAvAaCC8IAAIgRBASAEQQFLG0EBQQAtAMSC8IAAG2pB//8DcSIEQQAvAfSG8IAAQX9qQf//A3EiBSAEIAVJGzsB2obwgABBAEEAOgCBh/CAAAwhC0EAQQAvAdyG8IAAQQAvAaCC8IAAIgRBASAEQQFLG0EBQQAtAMSC8IAAG2pB//8DcSIEQQAvAfiG8IAAQX9qQf//A3EiBSAEIAVJGzsB3IbwgABBAEEAOgCBh/CAAAwgC0EAQQBBAC8B3IbwgAAiBEEALwGggvCAACIFQQEgBUEBSxtBAUEALQDEgvCAABtrIgUgBSAESxs7AdyG8IAAQQBBADoAgYfwgAAMHwtBAEEALwHahvCAAEEALwGggvCAACIEQQEgBEEBSxtBAUEALQDEgvCAABtqQf//A3EiBEEALwH0hvCAAEF/akH//wNxIgUgBCAFSRs7AdqG8IAAQQBBADoAgYfwgABBAEEAOwHchvCAAAweC0EAQQBBAC8B2obwgAAiBEEALwGggvCAACIFQQEgBUEBSxtBAUEALQDEgvCAABtrIgUgBSAESxs7AdqG8IAAQQBBADoAgYfwgABBAEEAOwHchvCAAAwdC0EAQQBBAC8BoILwgAAiBEF/aiIFIAUgBEsbQQBBAC0AxILwgAAbIgRBAC8B+IbwgAAiBUF/aiAEIAVJGzsB3IbwgABBAEEAOgCBh/CAAAwcCwJAAkACQEEALQDEgvCAAEUNAAJAQQAvAaCC8IAADgQBAgADHwsQn4CAgAAMHgtBAC8B2obwgABBAC8B3IbwgABBAC8B+IbwgAAQoICAgABBAC8B2obwgAAhBANAIARBAWoiBEH//wNxQQAvAfSG8IAATw0eIAQQoYCAgAAMAAsLQQAhBAJAA0AgBEH//wNxQQAvAdqG8IAAIgVPDQEgBBChgICAACAEQQFqIQQMAAsLIAVBAEEALwHchvCAAEEBahCggICAAAwcCxCfgICAAEEAKALQhvCAACIERQ0bIARCADcCoN+7AQwbCwJAAkACQEEALQDEgvCAAEUNAEEALwGggvCAAA4DAAECHQtBAC8B2obwgABBAC8B3IbwgABBAC8B+IbwgAAQoICAgAAMHAtBAC8B2obwgABBAEEALwHchvCAAEEBahCggICAAAwbC0EALwHahvCAABChgICAAAwaC0EALwHahvCAACIEQQAvAfKG8IAASQ0ZIARBAC8B2IbwgAAiBU8NGSAEIAVBAC8BoILwgAAiCEEBIAhBAUsbQQFBAC0AxILwgAAbEJ2AgIAADBkLQQAvAdqG8IAAIgRBAC8B8obwgABJDRggBEEALwHYhvCAACIFTw0YIAQgBUEALwGggvCAACIIQQEgCEEBSxtBAUEALQDEgvCAABsQooCAgAAMGAtBAC8B3IbwgAAiBEEMbCIHQZiAwIAAaiEFQQAvAaCC8IAAIghBASAIQQFLG0EBQQAtAMSC8IAAGyIJQQxsQZiAwIAAaiEKAkADQCAJIARqQQAvAfiG8IAAIghPDQEgB0EALwHahvCAAEGAGGxqIghBmIDAgABqIAogCGoiCykCADcCACAIQaCAwIAAaiALQQhqKAIANgIAIAVBDGohBSAHQQxqIQcgBEEBaiEEDAALCwJAA0BBAC8B2obwgAAhByAEIAhB//8DcU8NASAFIAdBgBhsaiIIQQApAoCAwIAANwIAIAhBCGpBACgCiIDAgAA2AgAgBUEMaiEFIARBAWohBEEALwH4hvCAACEIDAALCyAHQQE6AJyA8IAADBcLQQAvAaCC8IAAIgRBASAEQQFLG0EBQQAtAMSC8IAAGyEHQQAvAfKG8IAAIQUCQEEALQCDh/CAAA0AIAVB//8DcQ0AQQAhBUEAKALQhvCAACILRQ0AQQAhBUEAIQQDQCAEQf//A3EiCCAHTw0BIAhBAC8B2IbwgAAgBWtB//8DcU8NASALIAQgBWpB//8DcUGAGGxBmIDAgABqQQAvAfiG8IAAEKOAgIAAIARBAWohBEEALwHyhvCAACEFDAALCyAFQQAvAdiG8IAAIAcQooCAgAAMFgtBAC8B8obwgABBAC8B2IbwgABBAC8BoILwgAAiBEEBIARBAUsbQQFBAC0AxILwgAAbEJ2AgIAADBULQQAvAdqG8IAAQQAvAdyG8IAAIgQgBEEALwGggvCAACIFQQEgBUEBSxtBAUEALQDEgvCAABtqQf//A3EiBEEALwH4hvCAACIFIAQgBUkbEKCAgIAADBQLQQBBAC8B3IbwgABBAC8BoILwgAAiBEEBIARBAUsbQQFBAC0AxILwgAAbakH//wNxIgRBAC8B+IbwgABBf2pB//8DcSIFIAQgBUkbOwHchvCAAEEAQQA6AIGH8IAADBMLQQBBAEEALwGggvCAACIEQX9qIgUgBSAESxtBAEEALQDEgvCAABsiBEEALwH0hvCAACIFQX9qIAQgBUkbOwHahvCAAEEAQQA6AIGH8IAADBILQQBBAC8B2obwgABBAC8BoILwgAAiBEEBIARBAUsbQQFBAC0AxILwgAAbakH//wNxIgRBAC8B9IbwgABBf2pB//8DcSIFIAQgBUkbOwHahvCAAEEAQQA6AIGH8IAADBELAkACQEEALQDEgvCAAEUNAEEALwGggvCAAA4EABISARILQQAvAdyG8IAAIgRB/wFLDREgBEEAOgDHifCAAAwRC0GviTAhBANAIARBr4swRg0RIARBmIDAgABqQQA6AAAgBEEBaiEEDAALC0EAIQQCQEEALQDEgvCAACIFDQBBAEGAgoAINgLshvCAAEEAQQA6AP+G8IAADBALA0AgBEH/AXEiCCAFQf8BcU8NEAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAIAhBAXQvAaCC8IAAIgUOMgABAgMEBRQGBwgUFBQUFBQUFBQUFBQJCgsMFA0ODxQUFBQUFBQUEBEUFBQUFBQUFBITFAtBAEGAgoAINgLshvCAAEEAQQA6AP+G8IAADBQLQQBBAC0A/4bwgABBAXI6AP+G8IAADBMLQQBBAC0A/4bwgABBAnI6AP+G8IAADBILQQBBAC0A/4bwgABBBHI6AP+G8IAADBELQQBBAC0A/4bwgABBCHI6AP+G8IAADBALQQBBAC0A/4bwgABBEHI6AP+G8IAADA8LQQBBAC0A/4bwgABBIHI6AP+G8IAADA4LQQBBAC0A/4bwgABBwAByOgD/hvCAAAwNC0EAQQAtAP+G8IAAQYABcjoA/4bwgAAMDAtBAEEALQD/hvCAAEH8AXE6AP+G8IAADAsLQQBBAC0A/4bwgABB+wFxOgD/hvCAAAwKC0EAQQAtAP+G8IAAQfcBcToA/4bwgAAMCQtBAEEALQD/hvCAAEHvAXE6AP+G8IAADAgLQQBBAC0A/4bwgABB3wFxOgD/hvCAAAwHC0EAQQAtAP+G8IAAQb8BcToA/4bwgAAMBgtBAEEALQD/hvCAAEH/AHE6AP+G8IAADAULIARB7IbwgAAQpICAgABB/wFxIARqIQQMBAtBAEGAAjsB7IbwgAAMAwsgBEHuhvCAABCkgICAAEH/AXEgBGohBAwCC0EAQYACOwHuhvCAAAwBCwJAIAVBYmoiCEH//wNxQQhJDQACQCAFQfj/A3FBKEYNAAJAIAVBpn9qQf//A3FBCEkNACAFQZx/akH//wNxQQhPDQNBACAFQaR/ajsB7obwgAAMAwtBACAFQa5/ajsB7IbwgAAMAgtBACAFQVhqOwHuhvCAAAwBC0EAIAg7AeyG8IAACyAEQQFqIQRBAC0AxILwgAAhBQwACwsQmYCAgAAMDgsQmoCAgAAMDQtBAEEAQQAvAaCC8IAAIgRBf2oiBSAFIARLG0EAQQAtAMSC8IAAIgQbIgVBAC8B9IbwgAAiCEF/aiAFIAhJGzsB2obwgABBAEEAQQAvAaKC8IAAIgVBf2oiCCAIIAVLG0EAIARBAUsbIgRBAC8B+IbwgAAiBUF/aiAEIAVJGzsB3IbwgABBAEEAOgCBh/CAAAwMC0EAQQBBAC8BoILwgAAiBEF/aiIFIAUgBEsbQQBBAC0AxILwgAAbIgRBAC8B+IbwgAAiBUF/aiAEIAVJGzsB3IbwgABBAEEAOgCBh/CAAAwLCwJAQQAvAaCC8IAAIgRBASAEQQFLG0EBQQAtAMSC8IAAGyIIQQAvAdyG8IAAIgVqQf//A3FBAC8B+IbwgAAiBEkNAEEALwHahvCAACAFIAQQoICAgAAMCwsCQANAIARBf2oiBEH//wNxIAUgCGoiB0H//wNxSQ0BQQAvAdqG8IAAQYAYbEGYgMCAAGoiBSAEIAhrQf//A3FBDGxqIgcpAgAhBiAFIARB//8DcUEMbGoiBUEIaiAHQQhqKAIANgIAIAUgBjcCAEEALwHchvCAACEFDAALC0EAIAdB//8DcSIEQQAvAfiG8IAAIgggBCAISRsiBCAFQf//A3EiBWsiCCAIIARLGyEEIAVBDGxBmIDAgABqIQUCQANAQQAvAdqG8IAAIQggBEUNASAFIAhBgBhsaiIIQQApAoCAwIAANwIAIAhBCGpBACgCiIDAgAA2AgAgBEF/aiEEIAVBDGohBQwACwsgCEEBOgCcgPCAAAwKC0EAQQAvAaCC8IAAIgRBf2oiBSAFIARLG0EAQQAtAMSC8IAAIggbIgdBAC8BooLwgAAiBUEALwH0hvCAACIEIAUgBEkbIAQgBRsgBCAIQQFLGyIETw0JQQAgBDsB2IbwgABBACAHOwHyhvCAAEEAIAdBAEEALQD9hvCAABs7AdqG8IAAQQBBADoAgYfwgABBAEEAOwHchvCAAAwJC0EALQDEgvCAAEUNCEEALwGggvCAAEH//wNxQQZHDQggAUGbtgE7ACBBAC8B3IbwgAAhBCABQSBqIAFBIGpBAkEALwHahvCAAEEBahClgICAACIFQf8BcWpBOzoAACABQSBqIAFBIGogBUEBaiAEQQFqEKWAgIAAIgRB/wFxakHSADoAAAJAQcAARQ0AQYaJ8IAAIAFBIGpBwAD8CgAAC0EAIARBAWo6AMaJ8IAADAgLQQIhCEEBIQcCQAJAIAVB////AHEiBEGysn9qIgtBHEsNAEEBIAt0QcGAgIABcQ0BCwJAAkAgBEGQuH9qDgQCAQECAAsCQCAEQYayf2oOBAIBAQIACwJAIARBtLF/ag4DAgECAAsgBEH/zABGDQEgBEGTzQBGDQEgBEGhzQBGDQEgBEH1zQBGDQEgBEGFzgBGDQEgBEGozgBGDQEgBEHXzgBGDQEgBEGwzwBGDQEgBEG/zwBGDQEgBEHQ1gBGDQEgBEHV1gBGDQEgBEGE4AdGDQEgBEHP4QdGDQEgBEGO4wdGDQELQQJBASAFQf7/+wBxQYCA+ABqQf7/+wBxQf7/A0kgBUGQi/gAakH///8AcUGQAUkgBUGA/v8AcUGA8gdGIAVBgP//AHFBgO0HRiAFQYCa+ABqQf///wBxQdAGSSAFQaCb+ABqQf///wBxQQZJIAVB/v//AHEiCEHQ5AdGIAVBwJv4AGpB////AHFBCUkgBUHwm/gAakH///8AcUEsSSAFQYCc+ABqQf///wBxQQNJIAVB75z4AGpB////AHFBCkkgBUGggPwAakH///8AcUEHSSAFQf+B/ABqQf///wBxQeAASSAFQdCD/ABqQf///wBxQTxJIAVB8IP8AGpB////AHFBCkkgBUGAjvwAakH///8AcUGABEkgBUGAqP0AakH///8AcUGk1wBJIAVBoK39AGpB////AHFBHUkgBUGA5P4AakH///8AcUHHrQFJIAVBv5//AGpB////AHFB/zpJIAVBgKD/AGpB////AHFBP0kgBUGQoP8AakH///8AcUEMSSAFQYCi/wBqQf///wBxQdYBSSAFQeWi/wBqQf///wBxQdkASSAFQYCj/wBqQf///wBxQRpJIAVB5an/AGpB////AHFBAkkgBUHrsP8AakH///8AcUEDSSAFQa2x/wBqQf///wBxQQNJIAhBis4ARiAIQfLNAEYgCEHEzQBGIAVBw7L/AGpB////AHFBAkkgCEGqzQBGIAVBuLP/AGpB////AHFBDEkgCEGUzABGIAVBg7T/AGpB////AHFBAkkgBUGXuP8AakH///8AcUEESSAFQYDe/wBqQf///wBxQeAASSAFQde5/wBqQf///wBxQQJJciAIQZrGAEZycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJyciIHQQFxGyEICyABQQhqQQAvAdqG8IAAQQAvAdyG8IAAEKaAgIAAAkACQAJAAkACQAJAIAEtABEOAwEDAAMLQQAvAdyG8IAAIgVBAWoiC0H//wNxQQAvAfiG8IAATw0DDAELQQAhBUEALwHchvCAACILRQ0DIAFBFGpBAC8B2obwgAAgC0F/aiILEKaAgIAAIAEtAB1BAkcNAQtBAC8B2obwgAAgC0GAgMCAABCcgICAAAtBAC8B3IbwgAAhBQsCQCAFQf//A3ENAEEAIQUMAQsgAUEgakEALwHahvCAACAFQX9qEKaAgIAAQQAvAdyG8IAAIQUgAS0AKUECRw0AQQAvAdqG8IAAIAVBgIDAgAAQnICAgABBAC8B3IbwgAAhBQsCQCAHQQFxIgdFDQAgBUH//wNxQQAvAfiG8IAAQX9qQf//A3FHDQACQEEALQD+hvCAAEUNAEEAQQA7AdyG8IAAEJuAgIAAQQAvAdyG8IAAIQUMAQsgAUEBOwApIAFBIDYCICABQQA6ACsgAUEALQD/hvCAADoAKCABQQAoAuyG8IAANgIkQQAvAdqG8IAAIAUgAUEgahCcgICAAAwICyABIAg6AB0gASAENgIUIAFBADsBHiABQQAtAP+G8IAAOgAcIAFBACgC7IbwgAA2AhhBAC8B2obwgAAgBSABQRRqEJyAgIAAQQAvAfiG8IAAIQRBAC8B3IbwgAAhBQJAIAdFDQAgBUEBaiIHQf//A3EgBEH//wNxTw0AIAFBADoAKyABQQA7ACkgAUEgNgIgIAFBAC0A/4bwgAA6ACggAUEAKALshvCAADYCJEEALwHahvCAACAHIAFBIGoQnICAgABBAC8B+IbwgAAhBEEALwHchvCAACEFCwJAIAUgCGoiBUH//wNxIARB//8DcU8NAEEAIAU7AdyG8IAADAgLQQAtAP6G8IAARQ0HQQBBAToAgYfwgAAMBwtBACEFQQAgBDoAw4LwgAAgBEF4ag4GAAECAgIDBgtBAC8B3IbwgAAiBEUNBSAEQX9qIQUMAgtBAC8B+IbwgAAiB0EALwHchvCAACIEQQFqQf//A3EiBSAHIAVLGyELAkADQCAEQQFqIgUgB08NASAEQciJ8IAAaiEIIAUhBCAILQAAQQFHDQALIAUhCwsgCyAHQX9qIAUgB0kbIQUMAQsQm4CAgABBACEFQQAtAPyG8IAARQ0DC0EAIAU7AdyG8IAAQQBBADoAgYfwgAAMAgtBAEEGOgDCgvCAAAwBC0EAIAQ6AMmC8IAACyAAQQFqIQAMAAsL1wMBAX8CQCAAQQFxQQAtAIOH8IAARg0AQQAoAtSG8IAAIgJFDQACQAJAAkACQCAAQQFxRQ0AIAFBAXENAQwCCwJAQYSCMEUNAEGYgMCAACACQYSCMPwKAAALQQBBADoAg4fwgAACQCABQQFxRQ0AQQBBAC8B9obwgAA7AdqG8IAAQQBBAC8B8IbwgAA7AdyG8IAAQQBBAC8B6obwgAA7AeyG8IAAQQBBAC8B4IbwgAA7Ae6G8IAAQQBBAC0AgofwgAA6AP+G8IAAQQBBADoAgYfwgAALQYSAMCEAA0AgAEH8/09qQQAvAfSG8IAAIgFPDQMgAEGYgMCAAGpBAToAACAAQQFqIQAMAAsLQQBBAC8B2obwgAA7AfaG8IAAQQBBAC8B3IbwgAA7AfCG8IAAQQBBAC8B7IbwgAA7AeqG8IAAQQBBAC8B7obwgAA7AeCG8IAAQQBBAC0A/4bwgAA6AIKH8IAACwJAQYSCMEUNACACQZiAwIAAQYSCMPwKAAALQQBBAC8B9IbwgAA7AZqA8IAAQQBBAC8B+IbwgAA7AZiA8IAAEJ+AgIAAQQBBAToAg4fwgABBAC8B9IbwgAAhAQtBACABOwHYhvCAAEEAQQA7AfKG8IAACwtDAEEAQQAoAeKG8IAANgHahvCAAEEAQQAoAeaG8IAANgLshvCAAEEAQQAtAICH8IAAOgD/hvCAAEEAQQA6AIGH8IAACzgAQQBBACgB2obwgAA2AeKG8IAAQQBBACgC7IbwgAA2AeaG8IAAQQBBAC0A/4bwgAA6AICH8IAAC6MBAQN/AkACQEEALwHahvCAAEEBaiIAQf//A3FBAC8B2IbwgAAiAUkNAEEALwHyhvCAACEAQQAtAIOH8IAADQEgAEH//wNxDQFBACEAQQAoAtCG8IAAIgJFDQEgAkGYgMCAAEEALwH4hvCAABCjgICAAEEALwHYhvCAACEBQQAvAfKG8IAAIQAMAQtBACAAOwHahvCAAA8LIAAgAUEBEKKAgIAAC3UAAkAgAEH//wNxQQAvAZqA8IAATw0AIAFB//8DcUEALwGYgPCAAEH//wNxTw0AIABB//8DcSIAQYAYbCABQf//A3FBDGxqIgEgAikCADcCmIDAgAAgAUGggMCAAGogAkEIaigCADYCACAAQQE6AJyA8IAACwvfAQEEfwJAIAJB//8DcUUNACABQf//A3EgAEH//wNxTQ0AIAEgAGsiAyACQf//A3EiAiADQf//A3EiAyACIANJGyIEa0H//wNxIQVBACECA0ACQCAFIAJHDQAgBCAAakH//wNxIQIDQCAAQf//A3EgAk8NAyAAEKGAgIAAIABBAWohAAwACwsgASACQX9zaiIGQf//A3EhAwJAQYAYRQ0AIANBgBhsQZiAwIAAaiAGIARrQf//A3FBgBhsQZiAwIAAakGAGPwKAAALIANBAToAnIDwgAAgAkEBaiECDAALCwv5AgEBfyOAgICAAEGAAmsiAiSAgICAAEEAIAE7AZqA8IAAQQAgADsBmIDwgAAQn4CAgAACQEG0BEUNAEGcgvCAAEEAQbQE/AsAC0EAIAE7AfSG8IAAQQAgADsB+IbwgABBAEEBOgCEifCAAEEAQQE6AP6G8IAAQQAgATsB2IbwgABBAEKAgoAINwLshvCAAEEAQYCCgAg2AuiG8IAAQQBCgIKAgICAgIABNwLghvCAAEEAQQA2AdqG8IAAQQBBADoAgYfwgABBAEEAOwD/hvCAAEEAQQA7AfaG8IAAQQBBADYB+obwgABBAEEAOgCDh/CAAEEAQQA6AIKH8IAAQQBBADsB3obwgABBAEEAOgCFifCAAEEAQQA6AMaJ8IAAAkBBgAJFDQAgAkEAQYAC/AsAC0EIIQECQANAIAFB/wFLDQEgAiABakEBOgAAIAFBCGohAQwACwsCQEGAAkUNAEHHifCAACACQYAC/AoAAAsgAkGAAmokgICAgAALMgEBf0EAIQACQANAIABB//8DcUEALwGagPCAAE8NASAAEKGAgIAAIABBAWohAAwACwsLqAEBAX8CQCAAQf//A3EiA0EALwGagPCAAE8NAEEAIAJB//8DcSIAQQAvAZiA8IAAIgIgACACSRsiACABQf//A3EiAWsiAiACIABLGyECIANBgBhsIAFBDGxqQZiAwIAAaiEAAkADQCACRQ0BIABBCGpBACgCiIDAgAA2AgAgAEEAKQKAgMCAADcCACAAQQxqIQAgAkF/aiECDAALCyADQQE6AJyA8IAACwt9AQJ/AkAgAEH//wNxIgFBAC8BmoDwgABPDQAgAUGAGGxBmIDAgABqIQBBACECAkADQCACQQAvAZiA8IAATw0BIABBCGpBACgCiIDAgAA2AgAgAEEAKQKAgMCAADcCACAAQQxqIQAgAkEBaiECDAALCyABQQE6AJyA8IAACwvWAQEDfwJAIAJB//8DcUUNACABQf//A3EgAEH//wNxTQ0AIAJB//8DcSICIAEgAGtB//8DcSIDIAIgA0kbIgNBgBhsQZiAwIAAaiEEIAFB//8DcSEFIABB//8DcSIAQYAYbCECA0ACQCADIABqIAVJDQADQCAAQf//A3EgAUH//wNxTw0DIAAQoYCAgAAgAEEBaiEADAALCwJAQYAYRQ0AIAJBmIDAgABqIAQgAmpBgBj8CgAACyAAQZyA8IAAakEBOgAAIAJBgBhqIQIgAEEBaiEADAALCwuhAQIDfwF+IAJB//8DcSEDIAAgACgCpN+7AUGEGGxqIgQhBQJAA0AgA0UNASABKQIAIQYgBUEIaiABQQhqKAIANgIAIAUgBjcCACABQQxqIQEgBUEMaiEFIANBf2ohAwwACwsgBCACOwGAGCAAIAAoAqTfuwFBAWpB6AdwNgKk37sBAkAgACgCoN+7ASIBQegHTw0AIAAgAUEBajYCoN+7AQsL3QIBA39BACECAkAgAEEBakH/AXEiA0EALQDEgvCAACIETw0AAkACQAJAIANBAXQvAaCC8IAAQX5qDgQBAwMAAwsgAEECakH/AXEiACAETw0CIABBAXQvAaCC8IAAIQBBAiECDAELIABBBGpB/wFxIgMgBE8NASADQQF0LwGggvCAACECAkAgAEECakH/AXFBAXQvAaCC8IAAIgMgAEEDakH/AXFBAXQvAaCC8IAAIgBHDQAgACACQf//A3FHDQBBBCECAkAgA0H/AXEiAEEITw0AQRAhAAwCCwJAIABB+AFNDQBB5wEhAAwCCyADQXhqQf8BcUEKbkHoAWoiAEH/ASAAQf8BSRshAAwBCyADQQVsQf8AakH//wNxQf8BbkEkbCAAQQVsQf8AakH//wNxQf8BbkEGbGogAkEFbEH/AGpB//8DcUH/AW5qQRBqIQBBBCECCyABIAA7AQALIAILnQEBA38jgICAgABBEGsiAySAgICAAEEAIQQDfwJAIAJB//8DcSIFDQAgAUH/AXEhAiADQQtqQX9qIQUCQANAIARFDQEgACACaiAFIARqLQAAOgAAIAJBAWohAiAEQX9qIQQMAAsLIANBEGokgICAgAAgAg8LIANBC2ogBGogAiAFQQpuIgVBCmxrQTByOgAAIARBAWohBCAFIQIMAAsLiwEAAkACQCABQf//A3FBAC8BmoDwgABPDQAgAkH//wNxQQAvAZiA8IAAQf//A3FJDQELIABBCGpBACgCiIDAgAA2AgAgAEEAKQKAgMCAADcCAA8LIAAgAUH//wNxQYAYbCACQf//A3FBDGxqIgEpApiAwIAANwIAIABBCGogAUGggMCAAGooAgA2AgALCABB8IKsggALhAYBCH9BgAIgAUH//wNxIgJBASACQQFLGyICQYACIAJBgAJJGyABQYACSxshA0EALwH0hvCAACEEAkACQEGAAiAAQf//A3EiAUEBIAFBAUsbIgFBgAIgAUGAAkkbIABBgAJLGyIFQQAvAfiG8IAAIgJHDQAgAyAEQf//A3FGDQELAkAgBSACSSIGRQ0AIAMgBEH//wNxIgEgAyABSRshByAFQQxsQZiAwIAAaiEIQQAhCQNAIAkgB0YNASAIIQEgBSEAAkADQCACIABB//8DcUYNASABQQhqQQAoAoiAwIAANgIAIAFBACkCgIDAgAA3AgAgAUEMaiEBIABBAWohAAwACwsgCEGAGGohCCAJQQFqIQkMAAsLAkAgAyAEQf//A3EiCE8NAEEALQCDh/CAAA0AQQAoAtCG8IAARQ0AIAUgAiAGGyEJIANBgBhsQZiAwIAAaiEAIAMhAQNAIARB//8DcSABQf//A3FGDQFBACgC0IbwgAAgACAJEKOAgIAAIABBgBhqIQAgAUEBaiEBDAALC0EAIAM7AfSG8IAAQQAgBTsB+IbwgABBACADOwGagPCAAEEAIAU7AZiA8IAAAkAgAyAITQ0AIAQhAQNAIAFB//8DcSADTw0BIAEQoYCAgAAgAUEBaiEBDAALCwJAIAUgAk0NACADIARB//8DcSIBIAMgAUkbIQggBSACayEHIAJBDGxBmIDAgABqIQlBACECA0AgAiAIRg0BIAchACAJIQECQANAIABFDQEgAUEIakEAKAKIgMCAADYCACABQQApAoCAwIAANwIAIABBf2ohACABQQxqIQEMAAsLIAJBAToAnIDwgAAgCUGAGGohCSACQQFqIQIMAAsLQQAgAzsB2IbwgABBAEEAOwHyhvCAAAJAQQAvAdyG8IAAIAVJDQBBACAFQX9qOwHchvCAAAsCQEEALwHahvCAACADSQ0AQQAgA0F/ajsB2obwgAALQQAhAQNAIAMgAUYNASABQZyA8IAAakEBOgAAIAFBAWohAQwACwsLUwBBgAIgAEEBIAAbIABBgAJLG0GAAiABQQEgARsgAUGAAksbEJ6AgIAAQQBB8MKsggA2AtSG8IAAQQBByKPwgAA2AtCG8IAAQQBCADcC6IKsggALCyEBAEGAgMAACxggAAAAAAEAAQABAABFAAAAAAEAAQABAAA=";

// ../node_modules/.pnpm/@jsonstudio+wtermmod-core@0.1.9/node_modules/@jsonstudio/wtermmod-core/dist/wasm-bridge.js
function decodeBase64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++)
    bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
var WasmBridge = class _WasmBridge {
  constructor(instance) {
    this.gridPtr = 0;
    this.dirtyPtr = 0;
    this.writeBufferPtr = 0;
    this.cellSize = 12;
    this.maxCols = 256;
    this.encoder = new TextEncoder();
    this.decoder = new TextDecoder();
    this.exports = instance.exports;
    this.memory = this.exports.memory;
  }
  static async load(url) {
    let bytes;
    if (url) {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`[wterm] Failed to load WASM from ${url}: ${response.status} ${response.statusText}`);
      }
      bytes = await response.arrayBuffer();
    } else {
      bytes = decodeBase64(WASM_BASE64);
    }
    const { instance } = await WebAssembly.instantiate(bytes);
    return new _WasmBridge(instance);
  }
  init(cols, rows) {
    this.exports.init(cols, rows);
    this._updatePointers();
  }
  _updatePointers() {
    this.gridPtr = this.exports.getGridPtr();
    this.dirtyPtr = this.exports.getDirtyPtr();
    this.writeBufferPtr = this.exports.getWriteBuffer();
    this.cellSize = this.exports.getCellSize();
    this.maxCols = this.exports.getMaxCols();
    this._dv = new DataView(this.memory.buffer);
  }
  writeString(str) {
    const encoded = this.encoder.encode(str);
    this.writeRaw(encoded);
  }
  writeRaw(data) {
    const buf = new Uint8Array(this.memory.buffer, this.writeBufferPtr, 8192);
    let offset = 0;
    while (offset < data.length) {
      const chunk = Math.min(data.length - offset, 8192);
      buf.set(data.subarray(offset, offset + chunk));
      this.exports.writeBytes(chunk);
      offset += chunk;
    }
  }
  getCell(row, col) {
    const offset = this.gridPtr + (row * this.maxCols + col) * this.cellSize;
    const dv = this._dv;
    return {
      char: dv.getUint32(offset, true),
      fg: dv.getUint16(offset + 4, true),
      bg: dv.getUint16(offset + 6, true),
      flags: dv.getUint8(offset + 8),
      width: dv.getUint8(offset + 9)
    };
  }
  isDirtyRow(row) {
    return new Uint8Array(this.memory.buffer, this.dirtyPtr, 256)[row] !== 0;
  }
  clearDirty() {
    this.exports.clearDirty();
  }
  getCursor() {
    return {
      row: this.exports.getCursorRow(),
      col: this.exports.getCursorCol(),
      visible: this.exports.getCursorVisible() !== 0
    };
  }
  getCols() {
    return this.exports.getCols();
  }
  getRows() {
    return this.exports.getRows();
  }
  cursorKeysApp() {
    return this.exports.getCursorKeysApp() !== 0;
  }
  bracketedPaste() {
    return this.exports.getBracketedPaste() !== 0;
  }
  usingAltScreen() {
    return this.exports.getUsingAltScreen() !== 0;
  }
  getTitle() {
    if (this.exports.getTitleChanged() === 0)
      return null;
    const ptr = this.exports.getTitlePtr();
    const len = this.exports.getTitleLen();
    const bytes = new Uint8Array(this.memory.buffer, ptr, len);
    return this.decoder.decode(bytes);
  }
  getResponse() {
    const len = this.exports.getResponseLen();
    if (len === 0)
      return null;
    const ptr = this.exports.getResponsePtr();
    const bytes = new Uint8Array(this.memory.buffer, ptr, len);
    const str = this.decoder.decode(bytes);
    this.exports.clearResponse();
    return str;
  }
  getScrollbackCount() {
    return this.exports.getScrollbackCount();
  }
  getScrollbackCell(offset, col) {
    const ptr = this.exports.getScrollbackLine(offset);
    const off = ptr + col * this.cellSize;
    const dv = this._dv;
    return {
      char: dv.getUint32(off, true),
      fg: dv.getUint16(off + 4, true),
      bg: dv.getUint16(off + 6, true),
      flags: dv.getUint8(off + 8),
      width: dv.getUint8(off + 9)
    };
  }
  getScrollbackLineLen(offset) {
    return this.exports.getScrollbackLineLen(offset);
  }
  resize(cols, rows) {
    this.exports.resizeTerminal(cols, rows);
    this._updatePointers();
  }
};

// ../packages/shared/src/terminal/color.ts
var TRUECOLOR_COLOR_FLAG = 16777216;
function encodePackedTruecolorColor(red, green, blue) {
  const r = Math.max(0, Math.min(255, Math.floor(red || 0)));
  const g = Math.max(0, Math.min(255, Math.floor(green || 0)));
  const b = Math.max(0, Math.min(255, Math.floor(blue || 0)));
  return TRUECOLOR_COLOR_FLAG | r << 16 | g << 8 | b;
}

// src/server/mirror-line-canonicalizer.ts
function serializeCell(cell) {
  return {
    char: cell.char,
    fg: cell.fg,
    bg: cell.bg,
    flags: cell.flags,
    width: cell.width
  };
}
function readVisibleRow(bridge, row = 0) {
  const cols = bridge.getCols();
  const cells = [];
  for (let col = 0; col < cols; col += 1) {
    cells.push(serializeCell(bridge.getCell(row, col)));
  }
  return trimTrailingDefaultCells(cells);
}
function normalizeExtendedColorToken(token) {
  if (!token.includes(":")) {
    return token;
  }
  const parts = token.split(":");
  if (parts.length < 3) {
    return token.split(":").join(";");
  }
  const selector = parts[0];
  const mode = parts[1];
  if ((selector === "38" || selector === "48" || selector === "58") && (mode === "2" || mode === "5")) {
    return [selector, mode, ...parts.slice(2).filter((part) => part.length > 0)].join(";");
  }
  return token.split(":").join(";");
}
function normalizeAnsiExtendedColorSeparators(line) {
  if (!line.includes("\x1B[") || !line.includes(":")) {
    return line;
  }
  return line.replace(/\x1b\[([0-9:;]*)m/g, (_match, params) => {
    const normalizedParams = params.split(";").map((token) => normalizeExtendedColorToken(token)).join(";");
    return `\x1B[${normalizedParams}m`;
  });
}
function normalizeAnsiTruecolorPayload(line) {
  if (!line.includes("\x1B[") || !line.includes("38;2;") && !line.includes("48;2;") && !line.includes("38:2:") && !line.includes("48:2:")) {
    return line;
  }
  return line.replace(/\x1b\[([0-9;:]*)m/g, (match, params) => {
    const tokens = params.split(";").flatMap((token) => token.split(":").filter((part) => part.length > 0));
    if (tokens.length === 0) {
      return match;
    }
    const rewritten = [];
    let index = 0;
    while (index < tokens.length) {
      const token = tokens[index];
      if ((token === "38" || token === "48") && tokens[index + 1] === "2") {
        const red = Number.parseInt(tokens[index + 2] || "", 10);
        const green = Number.parseInt(tokens[index + 3] || "", 10);
        const blue = Number.parseInt(tokens[index + 4] || "", 10);
        if (Number.isFinite(red) && Number.isFinite(green) && Number.isFinite(blue)) {
          const packed = encodePackedTruecolorColor(red, green, blue);
          rewritten.push(token === "38" ? `\x9B_zterm_fg_${packed}_m` : `\x9B_zterm_bg_${packed}_m`);
          index += 5;
          continue;
        }
      }
      rewritten.push(`\x1B[${token}m`);
      index += 1;
    }
    return rewritten.join("");
  });
}
function applyPackedTruecolorHints(line, cells) {
  if (!line.includes("\x9B_zterm_")) {
    return cells;
  }
  const patched = cells.map((cell) => ({ ...cell }));
  const visibleColumns = [];
  for (let index = 0; index < patched.length; index += 1) {
    if (patched[index]?.width !== 0) {
      visibleColumns.push(index);
    }
  }
  let activeFg = null;
  let activeBg = null;
  let visibleCellCursor = 0;
  const tokenPattern = /(?:\u009b_zterm_(fg|bg)_(\d+)_m)|(?:\x1b\[0m)|(?:\x1b\[[0-9;:]*m)|([\s\S])/gu;
  let match;
  while ((match = tokenPattern.exec(line)) !== null) {
    if (match[1] && match[2]) {
      const packed = Number.parseInt(match[2], 10);
      if (Number.isFinite(packed)) {
        if (match[1] === "fg") {
          activeFg = packed;
        } else {
          activeBg = packed;
        }
      }
      continue;
    }
    if (match[0] === "\x1B[0m") {
      activeFg = null;
      activeBg = null;
      continue;
    }
    if (match[0].startsWith("\x1B[")) {
      const params = match[0].slice(2, -1).split(";").filter((part) => part.length > 0);
      if (params.includes("0") || params.includes("39")) {
        activeFg = null;
      }
      if (params.includes("0") || params.includes("49")) {
        activeBg = null;
      }
      continue;
    }
    const char = match[3];
    if (!char) {
      continue;
    }
    const cellColumn = visibleColumns[visibleCellCursor];
    visibleCellCursor += 1;
    if (typeof cellColumn !== "number") {
      continue;
    }
    if (activeFg !== null) {
      patched[cellColumn].fg = activeFg;
    }
    if (activeBg !== null) {
      patched[cellColumn].bg = activeBg;
    }
  }
  return patched;
}
async function canonicalizeCapturedMirrorLines(capturedLines, cols, bridge) {
  if (capturedLines.length === 0) {
    return [];
  }
  const parserBridge = bridge ?? await WasmBridge.load();
  const safeCols = Math.max(1, Math.floor(cols) || 1);
  const canonicalLines = [];
  for (const line of capturedLines) {
    parserBridge.init(safeCols, 1);
    if (line.length > 0) {
      parserBridge.writeString(normalizeAnsiExtendedColorSeparators(line));
    }
    const normalizedRawLine = normalizeAnsiTruecolorPayload(normalizeAnsiExtendedColorSeparators(line));
    canonicalLines.push(applyPackedTruecolorHints(normalizedRawLine, readVisibleRow(parserBridge, 0)));
  }
  return canonicalLines;
}

// src/server/terminal-mirror-capture.ts
var sharedScratchBridgePromise = null;
function loadSharedScratchBridge() {
  if (!sharedScratchBridgePromise) {
    sharedScratchBridgePromise = WasmBridge.load();
  }
  return sharedScratchBridgePromise;
}
var MIRROR_CAPTURE_STABILIZE_MAX_ATTEMPTS = 4;
function normalizeMirrorCursor(options) {
  const safePaneRows = Math.max(1, Math.floor(options.paneRows || 1));
  const safeBufferStartIndex = Math.max(0, Math.floor(options.bufferStartIndex || 0));
  const safeAvailableEndIndex = Math.max(safeBufferStartIndex, Math.floor(options.availableEndIndex || 0));
  if (safeAvailableEndIndex <= safeBufferStartIndex) {
    return null;
  }
  const visibleTopIndex = Math.max(safeBufferStartIndex, safeAvailableEndIndex - safePaneRows);
  const rowIndex = Math.max(
    visibleTopIndex,
    Math.min(safeAvailableEndIndex - 1, visibleTopIndex + Math.max(0, Math.floor(options.cursor.row || 0)))
  );
  return {
    rowIndex,
    col: Math.max(0, Math.floor(options.cursor.col || 0)),
    visible: Boolean(options.cursor.visible)
  };
}
function getMirrorAvailableEndIndex2(mirror) {
  return mirror.bufferStartIndex + mirror.bufferLines.length;
}
function cursorStatesEqual(left, right) {
  return (left?.rowIndex ?? null) === (right?.rowIndex ?? null) && (left?.col ?? null) === (right?.col ?? null) && (left?.visible ?? null) === (right?.visible ?? null);
}
function mirrorCaptureSnapshotsEqual(left, right) {
  if (left.rows !== right.rows || left.cols !== right.cols || left.cursorKeysApp !== right.cursorKeysApp || left.lastScrollbackCount !== right.lastScrollbackCount || left.bufferStartIndex !== right.bufferStartIndex || !cursorStatesEqual(left.cursor, right.cursor) || left.bufferLines.length !== right.bufferLines.length) {
    return false;
  }
  for (let index = 0; index < left.bufferLines.length; index += 1) {
    if (!rowsEqual(left.bufferLines[index], right.bufferLines[index])) {
      return false;
    }
  }
  return true;
}
function mirrorCaptureSnapshotWindowEqual(left, right) {
  return left.rows === right.rows && left.cols === right.cols && left.cursorKeysApp === right.cursorKeysApp && left.lastScrollbackCount === right.lastScrollbackCount && left.bufferStartIndex === right.bufferStartIndex && left.bufferLines.length === right.bufferLines.length && left.capturedLineCount === right.capturedLineCount && left.canonicalLineCount === right.canonicalLineCount && left.totalAvailableLines === right.totalAvailableLines && left.visibleTopIndex === right.visibleTopIndex;
}
function currentMirrorMatchesSnapshot(mirror, snapshot) {
  return mirrorCaptureSnapshotsEqual(
    {
      rows: mirror.rows,
      cols: mirror.cols,
      cursorKeysApp: mirror.cursorKeysApp,
      lastScrollbackCount: mirror.lastScrollbackCount,
      bufferStartIndex: mirror.bufferStartIndex,
      bufferLines: mirror.bufferLines,
      cursor: mirror.cursor,
      capturedLineCount: mirror.bufferLines.length,
      canonicalLineCount: mirror.bufferLines.length,
      totalAvailableLines: getMirrorAvailableEndIndex2(mirror),
      visibleTopIndex: Math.max(mirror.bufferStartIndex, getMirrorAvailableEndIndex2(mirror) - mirror.rows),
      captureDurationMs: mirror.lastCaptureDurationMs || 0,
      canonicalizeDurationMs: mirror.lastCanonicalizeDurationMs || 0,
      captureStartedAt: 0,
      captureDoneAt: 0,
      canonicalizeDoneAt: 0
    },
    snapshot
  );
}
function applyMirrorCaptureSnapshot(mirror, snapshot) {
  mirror.rows = snapshot.rows;
  mirror.cols = snapshot.cols;
  mirror.cursorKeysApp = snapshot.cursorKeysApp;
  mirror.lastScrollbackCount = snapshot.lastScrollbackCount;
  mirror.bufferStartIndex = snapshot.bufferStartIndex;
  mirror.bufferLines = snapshot.bufferLines;
  mirror.cursor = snapshot.cursor;
}
async function resolveStableMirrorCaptureSnapshot(options) {
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts || MIRROR_CAPTURE_STABILIZE_MAX_ATTEMPTS));
  const firstSnapshot = await options.readSnapshot();
  if (options.currentMirror && currentMirrorMatchesSnapshot(options.currentMirror, firstSnapshot)) {
    return {
      snapshot: firstSnapshot,
      attempts: 1,
      stabilized: true,
      stabilizedAgainst: "current-mirror"
    };
  }
  let previousSnapshot = firstSnapshot;
  for (let attempt = 2; attempt <= maxAttempts; attempt += 1) {
    const nextSnapshot = await options.readSnapshot();
    if (mirrorCaptureSnapshotsEqual(previousSnapshot, nextSnapshot)) {
      return {
        snapshot: nextSnapshot,
        attempts: attempt,
        stabilized: true,
        stabilizedAgainst: "consecutive-capture"
      };
    }
    if (mirrorCaptureSnapshotWindowEqual(previousSnapshot, nextSnapshot)) {
      return {
        snapshot: nextSnapshot,
        attempts: attempt,
        stabilized: true,
        stabilizedAgainst: "consecutive-window"
      };
    }
    previousSnapshot = nextSnapshot;
  }
  throw new Error(`tmux capture remained unstable after ${maxAttempts} attempts`);
}
function resolveAuthoritativeMirrorCaptureWindow(options) {
  const nextLines = options.nextLines;
  const safeComputedStartIndex = Math.max(0, Math.floor(options.computedStartIndex || 0));
  return {
    startIndex: safeComputedStartIndex,
    lines: nextLines,
    continuity: "authoritative-replace",
    matchedRows: 0
  };
}
function createTerminalMirrorCaptureRuntime(deps) {
  function readTmuxStatusLineCount() {
    try {
      const result = deps.runTmux(["display-message", "-p", "#{?status,1,0}"]);
      return result.stdout.trim() === "1" ? 1 : 0;
    } catch (error) {
      console.warn(
        `[${deps.logTimePrefix()}] failed to read tmux status line count; defaulting to 0: ${error instanceof Error ? error.message : String(error)}`
      );
      return 0;
    }
  }
  function resolveRequestedTmuxRows(contentRows) {
    const safeContentRows = Math.max(1, Math.floor(contentRows));
    return safeContentRows + readTmuxStatusLineCount();
  }
  function readTmuxPaneMetrics(sessionName) {
    if (deps.wezTermBackend) {
      const session = deps.wezTermBackend.listSessions().find((entry) => entry.sessionName === sessionName);
      if (!session) {
        throw new Error(`wezterm session not found: ${sessionName}`);
      }
      return {
        paneId: String(session.paneId),
        tmuxAvailableLineCountHint: session.rows + session.cols,
        paneRows: session.rows,
        paneCols: session.cols,
        alternateOn: false
      };
    }
    const result = deps.runTmux([
      "display-message",
      "-p",
      "-t",
      sessionName,
      "#{pane_id}	#{history_size}	#{pane_height}	#{pane_width}	#{alternate_on}	#{pane_dead}"
    ]);
    const [paneIdRaw, tmuxHistorySizeRaw, rowsRaw, colsRaw, alternateOnRaw, paneDeadRaw] = result.stdout.trim().split("	");
    const paneRows = Number.parseInt(rowsRaw ?? "", 10);
    const paneCols = Number.parseInt(colsRaw ?? "", 10);
    if (!Number.isFinite(paneRows) || paneRows <= 0 || !Number.isFinite(paneCols) || paneCols <= 0) {
      throw new Error(`tmux returned invalid pane metrics for ${sessionName}: rows=${rowsRaw ?? ""} cols=${colsRaw ?? ""}`);
    }
    if (paneDeadRaw === "1") {
      throw new Error(`tmux returned invalid pane metrics for ${sessionName}: pane is dead`);
    }
    const historySize = Math.max(0, Number.parseInt(tmuxHistorySizeRaw ?? "", 10) || 0);
    const alternateOn = alternateOnRaw === "1";
    return {
      paneId: paneIdRaw?.trim() || sessionName,
      // tmux history_size only counts scrollback; the visible pane rows are separate.
      // Session mirror truth must stay continuous even when alternate_on flips on.
      tmuxAvailableLineCountHint: historySize + paneRows,
      paneRows,
      paneCols,
      alternateOn
    };
  }
  function readTmuxPaneCurrentPath(sessionName) {
    if (deps.wezTermBackend) {
      return deps.wezTermBackend.readCurrentPath(sessionName);
    }
    const result = deps.runTmux(["display-message", "-p", "-t", sessionName, "#{pane_current_path}"]);
    const currentPath = result.stdout.trim();
    if (!currentPath) {
      throw new Error(`tmux returned empty pane_current_path for ${sessionName}`);
    }
    return currentPath;
  }
  async function readTmuxCursorStateAsync(target) {
    const result = await deps.runTmuxAsync([
      "display-message",
      "-p",
      "-t",
      target,
      "#{cursor_x} #{cursor_y} #{cursor_flag} #{keypad_cursor_flag}"
    ]);
    const [colRaw = "0", rowRaw = "0", visibleRaw = "0", cursorKeysAppRaw = "0"] = result.stdout.trim().split(/\s+/u);
    return {
      col: Math.max(0, Number.parseInt(colRaw, 10) || 0),
      row: Math.max(0, Number.parseInt(rowRaw, 10) || 0),
      visible: visibleRaw === "1",
      cursorKeysApp: cursorKeysAppRaw === "1"
    };
  }
  async function captureTmuxMirrorLinesAsync(target, options) {
    const safePaneRows = Math.max(1, Math.floor(options.paneRows));
    const safeMaxLines = Math.max(1, Math.floor(options.maxLines));
    const captureResult = await deps.runTmuxAsync([
      "capture-pane",
      "-p",
      "-e",
      "-N",
      "-t",
      target,
      "-S",
      `-${safeMaxLines}`,
      "-E",
      `${Math.max(0, safePaneRows - 1)}`
    ]);
    const normalizedLines = normalizeMirrorCaptureLines(captureResult.stdout, {
      paneRows: safePaneRows,
      alternateOn: options.alternateOn
    });
    if (normalizedLines.length <= safeMaxLines) {
      return normalizedLines;
    }
    return normalizedLines.slice(-safeMaxLines);
  }
  async function readTmuxPaneMetricsAsync(sessionName) {
    const result = await deps.runTmuxAsync([
      "display-message",
      "-p",
      "-t",
      sessionName,
      "#{pane_id}	#{history_size}	#{pane_height}	#{pane_width}	#{alternate_on}	#{pane_dead}"
    ]);
    const [paneIdRaw, tmuxHistorySizeRaw, rowsRaw, colsRaw, alternateOnRaw, paneDeadRaw] = result.stdout.trim().split("	");
    const paneRows = Number.parseInt(rowsRaw ?? "", 10);
    const paneCols = Number.parseInt(colsRaw ?? "", 10);
    if (!Number.isFinite(paneRows) || paneRows <= 0 || !Number.isFinite(paneCols) || paneCols <= 0) {
      throw new Error(`tmux returned invalid pane metrics for ${sessionName}: rows=${rowsRaw ?? ""} cols=${colsRaw ?? ""}`);
    }
    if (paneDeadRaw === "1") {
      throw new Error(`tmux returned invalid pane metrics for ${sessionName}: pane is dead`);
    }
    const historySize = Math.max(0, Number.parseInt(tmuxHistorySizeRaw ?? "", 10) || 0);
    const alternateOn = alternateOnRaw === "1";
    return {
      paneId: paneIdRaw?.trim() || sessionName,
      tmuxAvailableLineCountHint: historySize + paneRows,
      paneRows,
      paneCols,
      alternateOn
    };
  }
  async function captureTmuxMirrorSnapshot(mirror) {
    const captureStartedAt = Date.now();
    const metrics = await readTmuxPaneMetricsAsync(mirror.sessionName);
    const cursor = await readTmuxCursorStateAsync(metrics.paneId);
    const maxLines = deps.resolveMirrorCacheLines(metrics.paneRows);
    const capturedLines = await captureTmuxMirrorLinesAsync(metrics.paneId, {
      paneRows: metrics.paneRows,
      maxLines,
      alternateOn: metrics.alternateOn
    });
    const captureDoneAt = Date.now();
    const scratchBridge = mirror.scratchBridge ?? await loadSharedScratchBridge();
    mirror.scratchBridge = scratchBridge;
    const canonicalizeStartedAt = Date.now();
    const nextBufferLines = await canonicalizeCapturedMirrorLines(capturedLines, metrics.paneCols, scratchBridge);
    const canonicalizeDoneAt = Date.now();
    const resolvedAvailableLineCount = resolveCanonicalAvailableLineCount({
      paneRows: metrics.paneRows,
      tmuxAvailableLineCountHint: metrics.tmuxAvailableLineCountHint,
      capturedLineCount: capturedLines.length,
      scratchLineCount: nextBufferLines.length
    });
    const totalAvailableLines = Math.max(
      resolvedAvailableLineCount,
      getMirrorAvailableEndIndex2(mirror)
    );
    const computedStartIndex = Math.max(0, totalAvailableLines - nextBufferLines.length);
    const authoritativeWindow = resolveAuthoritativeMirrorCaptureWindow({
      nextLines: nextBufferLines,
      computedStartIndex
    });
    const trimmed = trimCanonicalBufferWindow(
      authoritativeWindow.startIndex,
      authoritativeWindow.lines,
      deps.resolveMirrorCacheLines(metrics.paneRows)
    );
    const availableEndIndex = trimmed.startIndex + trimmed.lines.length;
    const normalizedCursor = normalizeMirrorCursor({
      bufferStartIndex: trimmed.startIndex,
      availableEndIndex,
      paneRows: metrics.paneRows,
      cursor
    });
    const visibleTopIndex = Math.max(trimmed.startIndex, availableEndIndex - metrics.paneRows);
    return {
      rows: metrics.paneRows,
      cols: metrics.paneCols,
      cursorKeysApp: cursor.cursorKeysApp,
      lastScrollbackCount: Math.max(0, authoritativeWindow.lines.length - metrics.paneRows),
      bufferStartIndex: trimmed.startIndex,
      bufferLines: trimmed.lines,
      cursor: normalizedCursor,
      capturedLineCount: capturedLines.length,
      canonicalLineCount: nextBufferLines.length,
      totalAvailableLines,
      visibleTopIndex,
      captureDurationMs: Math.max(0, captureDoneAt - captureStartedAt),
      canonicalizeDurationMs: Math.max(0, canonicalizeDoneAt - canonicalizeStartedAt),
      captureStartedAt,
      captureDoneAt,
      canonicalizeDoneAt
    };
  }
  async function captureMirrorAuthoritativeBufferFromTmux(mirror) {
    if (deps.wezTermBackend) {
      const snapshot2 = await deps.wezTermBackend.readSnapshot(mirror.sessionName);
      applyMirrorCaptureSnapshot(mirror, {
        rows: snapshot2.rows,
        cols: snapshot2.cols,
        cursorKeysApp: snapshot2.cursorKeysApp,
        lastScrollbackCount: Math.max(0, snapshot2.bufferLines.length - snapshot2.rows),
        bufferStartIndex: snapshot2.bufferStartIndex,
        bufferLines: snapshot2.bufferLines,
        cursor: snapshot2.cursor,
        capturedLineCount: snapshot2.bufferLines.length,
        canonicalLineCount: snapshot2.bufferLines.length,
        totalAvailableLines: snapshot2.bufferStartIndex + snapshot2.bufferLines.length,
        visibleTopIndex: Math.max(snapshot2.bufferStartIndex, snapshot2.bufferStartIndex + snapshot2.bufferLines.length - snapshot2.rows),
        captureDurationMs: 0,
        canonicalizeDurationMs: 0,
        captureStartedAt: Date.now(),
        captureDoneAt: Date.now(),
        canonicalizeDoneAt: Date.now()
      });
      mirror.lastCaptureDurationMs = 0;
      mirror.lastCanonicalizeDurationMs = 0;
      mirror.pendingStableCaptureSnapshot = null;
      mirror.pendingPerformanceTraceCapture = null;
      return true;
    }
    const stableCapture = await resolveStableMirrorCaptureSnapshot({
      readSnapshot: () => captureTmuxMirrorSnapshot(mirror),
      currentMirror: mirror
    });
    const snapshot = stableCapture.snapshot;
    applyMirrorCaptureSnapshot(mirror, snapshot);
    mirror.lastCaptureDurationMs = snapshot.captureDurationMs;
    mirror.lastCanonicalizeDurationMs = snapshot.canonicalizeDurationMs;
    mirror.pendingStableCaptureSnapshot = null;
    mirror.pendingPerformanceTraceCapture = {
      captureStartedAt: snapshot.captureStartedAt ?? Date.now(),
      captureDoneAt: snapshot.captureDoneAt ?? Date.now(),
      canonicalizeDoneAt: snapshot.canonicalizeDoneAt ?? Date.now(),
      capturedLineCount: snapshot.capturedLineCount,
      canonicalLineCount: snapshot.canonicalLineCount
    };
    console.log(
      `[${deps.logTimePrefix()}] [mirror:${mirror.sessionName}] tmux capture sync captured=${snapshot.capturedLineCount} canonical=${snapshot.canonicalLineCount} continuity=authoritative-replace matched=0 total=${snapshot.totalAvailableLines} rows=${snapshot.rows} cols=${snapshot.cols} buffer=${mirror.bufferStartIndex}-${getMirrorAvailableEndIndex2(mirror)} visible=${snapshot.visibleTopIndex}-${getMirrorAvailableEndIndex2(mirror)} stabilizeAttempts=${stableCapture.attempts} stabilizeMode=${stableCapture.stabilizedAgainst}`
    );
    return true;
  }
  return {
    readTmuxStatusLineCount,
    resolveRequestedTmuxRows,
    readTmuxPaneMetrics,
    readTmuxPaneCurrentPath,
    captureMirrorAuthoritativeBufferFromTmux
  };
}

// src/server/schedule-dispatch.ts
function appendEnter(payload, enabled) {
  return enabled ? `${payload}\r` : payload;
}
function dispatchScheduledJob(context, job) {
  const sessionName = job.targetSessionName.trim();
  if (!sessionName) {
    return {
      ok: false,
      message: "missing target session",
      disable: true
    };
  }
  const payload = appendEnter(job.payload.text, job.payload.appendEnter);
  if (context.writeToLiveMirror(sessionName, payload, false)) {
    return { ok: true };
  }
  try {
    context.writeToTmuxSession(sessionName, job.payload.text, job.payload.appendEnter);
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const disable = /no server running|can't find session|can't find pane|no such file|target.*not found/i.test(message);
    return {
      ok: false,
      message,
      disable
    };
  }
}

// src/server/runtime-debug-store.ts
var DEFAULT_MAX_STORED_ENTRIES = 2e3;
var MAX_QUERY_LIMIT = 1e3;
var RuntimeDebugStore = class {
  maxEntries;
  entries = [];
  snapshots = /* @__PURE__ */ new Map();
  constructor(options) {
    const requestedMaxEntries = Math.floor(options?.maxEntries || DEFAULT_MAX_STORED_ENTRIES);
    this.maxEntries = Math.max(1, requestedMaxEntries);
  }
  appendBatch(source, entries) {
    const ingestedAt = (/* @__PURE__ */ new Date()).toISOString();
    for (const entry of entries) {
      this.entries.push({
        ...entry,
        ingestedAt,
        sessionId: source.sessionId,
        tmuxSessionName: source.tmuxSessionName,
        requestOrigin: source.requestOrigin
      });
    }
    const overflow = this.entries.length - this.maxEntries;
    if (overflow > 0) {
      this.entries.splice(0, overflow);
    }
  }
  setSnapshot(source, snapshot) {
    this.snapshots.set(source.sessionId, {
      sessionId: source.sessionId,
      tmuxSessionName: source.tmuxSessionName,
      requestOrigin: source.requestOrigin,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      snapshot
    });
  }
  getSnapshot(sessionId) {
    return this.snapshots.get(sessionId.trim()) || null;
  }
  listSnapshots() {
    return Array.from(this.snapshots.values()).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }
  listEntries(query) {
    const sessionId = query?.sessionId?.trim();
    const tmuxSessionName = query?.tmuxSessionName?.trim();
    const scopeIncludes = query?.scopeIncludes?.trim().toLowerCase();
    const limit = Math.max(1, Math.min(MAX_QUERY_LIMIT, Math.floor(query?.limit || 200)));
    const filtered = this.entries.filter((entry) => {
      if (sessionId && entry.sessionId !== sessionId) {
        return false;
      }
      if (tmuxSessionName && entry.tmuxSessionName !== tmuxSessionName) {
        return false;
      }
      if (scopeIncludes && !entry.scope.toLowerCase().includes(scopeIncludes)) {
        return false;
      }
      return true;
    });
    return filtered.slice(Math.max(0, filtered.length - limit)).reverse();
  }
  getSummary() {
    const sessions2 = /* @__PURE__ */ new Map();
    for (const entry of this.entries) {
      const current = sessions2.get(entry.sessionId);
      if (!current) {
        sessions2.set(entry.sessionId, {
          sessionId: entry.sessionId,
          tmuxSessionName: entry.tmuxSessionName,
          requestOrigin: entry.requestOrigin,
          entryCount: 1,
          latestSeq: entry.seq,
          latestScope: entry.scope,
          latestTs: entry.ts,
          latestIngestedAt: entry.ingestedAt
        });
        continue;
      }
      current.entryCount += 1;
      if (entry.seq >= current.latestSeq) {
        current.latestSeq = entry.seq;
        current.latestScope = entry.scope;
        current.latestTs = entry.ts;
        current.latestIngestedAt = entry.ingestedAt;
        current.tmuxSessionName = entry.tmuxSessionName;
        current.requestOrigin = entry.requestOrigin;
      }
    }
    return {
      totalEntries: this.entries.length,
      sessions: Array.from(sessions2.values()).sort((left, right) => right.latestSeq - left.latestSeq),
      snapshotCount: this.snapshots.size
    };
  }
};
function createRuntimeDebugStore(options) {
  return new RuntimeDebugStore(options);
}
function resolveDebugRouteLimit(input) {
  const parsed = Number.parseInt(input || "", 10);
  if (!Number.isFinite(parsed)) {
    return 200;
  }
  return Math.max(1, Math.min(MAX_QUERY_LIMIT, parsed));
}

// src/server/schedule-store.ts
var import_fs2 = require("fs");
var import_path2 = require("path");
var import_os2 = require("os");
var CURRENT_SCHEMA_VERSION = 1;
function getScheduleStorePath(homeDir = (0, import_os2.homedir)()) {
  return (0, import_path2.join)(getWtermHomeDir(homeDir), "schedules.json");
}
function loadScheduleStore(storePath = getScheduleStorePath()) {
  if (!(0, import_fs2.existsSync)(storePath)) {
    return {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      jobs: [],
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
  }
  try {
    const parsed = JSON.parse((0, import_fs2.readFileSync)(storePath, "utf-8"));
    return {
      schemaVersion: typeof parsed.schemaVersion === "number" && Number.isFinite(parsed.schemaVersion) ? parsed.schemaVersion : CURRENT_SCHEMA_VERSION,
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
      updatedAt: typeof parsed.updatedAt === "string" && parsed.updatedAt.trim() ? parsed.updatedAt : (/* @__PURE__ */ new Date()).toISOString()
    };
  } catch (error) {
    throw new Error(
      `[schedule-store] Failed to load ${storePath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
function saveScheduleStore(jobs, storePath = getScheduleStorePath()) {
  (0, import_fs2.mkdirSync)((0, import_path2.dirname)(storePath), { recursive: true });
  const payload = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    jobs,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  (0, import_fs2.writeFileSync)(storePath, `${JSON.stringify(payload, null, 2)}
`, "utf-8");
}

// ../packages/shared/src/connection/protocol.ts
var TERMINAL_MUX_PROTOCOL_VERSION = 1;
var TERMINAL_MUX_TARGET_CLIENT_MESSAGE_TYPES = [
  "list-sessions",
  "tmux-create-session",
  "tmux-rename-session",
  "tmux-kill-session"
];
var TERMINAL_MUX_LEGACY_CLIENT_MESSAGE_TYPES = [
  "session-open",
  "connect",
  "ping",
  "close"
];
var TERMINAL_MUX_TARGET_CLIENT_MESSAGE_SET = new Set(TERMINAL_MUX_TARGET_CLIENT_MESSAGE_TYPES);
var TERMINAL_MUX_LEGACY_CLIENT_MESSAGE_SET = new Set(TERMINAL_MUX_LEGACY_CLIENT_MESSAGE_TYPES);
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function asNonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}
function hasFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}
function isTerminalMuxTargetClientMessageType(type) {
  return TERMINAL_MUX_TARGET_CLIENT_MESSAGE_SET.has(type);
}
function isTerminalMuxLegacyClientMessageType(type) {
  return TERMINAL_MUX_LEGACY_CLIENT_MESSAGE_SET.has(type);
}
function classifyTerminalMuxClientMessage(message) {
  if (isTerminalMuxTargetClientMessageType(message.type)) {
    return "target";
  }
  if (isTerminalMuxLegacyClientMessageType(message.type)) {
    return "legacy";
  }
  return "channel";
}
function buildTerminalMuxCapabilities(options = {}) {
  return {
    version: TERMINAL_MUX_PROTOCOL_VERSION,
    channelEnvelope: true,
    targetMessages: true,
    boundedBodyScheduler: true,
    ...options
  };
}
function buildTerminalMuxReady(options = {}) {
  return {
    type: "mux-ready",
    payload: {
      version: TERMINAL_MUX_PROTOCOL_VERSION,
      ...asNonEmptyString(options.daemonHostId) ? { daemonHostId: asNonEmptyString(options.daemonHostId) } : {},
      capabilities: options.capabilities || buildTerminalMuxCapabilities()
    }
  };
}
function buildTerminalMuxServerChannelMessage(channelId, message) {
  const normalizedChannelId = asNonEmptyString(channelId);
  if (!normalizedChannelId) {
    throw new Error("terminal mux channelId is required");
  }
  return {
    type: "mux-channel-message",
    payload: {
      channelId: normalizedChannelId,
      message
    }
  };
}
function buildTerminalMuxServerTargetMessage(message, requestId) {
  return {
    type: "mux-target-message",
    payload: {
      ...asNonEmptyString(requestId) ? { requestId: asNonEmptyString(requestId) } : {},
      message
    }
  };
}
function buildTerminalMuxError(code, message, channelId) {
  return {
    type: "mux-error",
    payload: {
      code,
      message,
      ...asNonEmptyString(channelId) ? { channelId: asNonEmptyString(channelId) } : {}
    }
  };
}
function buildTerminalMuxUnwrappedSessionMessageError(messageType) {
  return buildTerminalMuxError(
    "mux_unwrapped_session_message",
    `session-bound message ${messageType} must be sent inside mux-channel-message`
  );
}
function isTerminalMuxClientFrame(value) {
  if (!isRecord(value) || typeof value.type !== "string" || !isRecord(value.payload)) {
    return false;
  }
  switch (value.type) {
    case "mux-hello":
      return value.payload.version === TERMINAL_MUX_PROTOCOL_VERSION && Boolean(asNonEmptyString(value.payload.clientInstanceId));
    case "mux-target-message":
      return isRecord(value.payload.message) && typeof value.payload.message.type === "string" && isTerminalMuxTargetClientMessageType(value.payload.message.type);
    case "mux-channel-open":
      return Boolean(asNonEmptyString(value.payload.channelId)) && Boolean(asNonEmptyString(value.payload.sessionName)) && (typeof value.payload.bodySubscribed === "undefined" || typeof value.payload.bodySubscribed === "boolean");
    case "mux-channel-message":
      return Boolean(asNonEmptyString(value.payload.channelId)) && isRecord(value.payload.message) && typeof value.payload.message.type === "string" && classifyTerminalMuxClientMessage(value.payload.message) === "channel";
    case "mux-channel-binary":
      return Boolean(asNonEmptyString(value.payload.channelId)) && typeof value.payload.dataBase64 === "string";
    case "mux-channel-close":
      return Boolean(asNonEmptyString(value.payload.channelId));
    case "mux-ping":
      return hasFiniteNumber(value.payload.sentAt);
    default:
      return false;
  }
}
function validateTerminalMuxChannelEnvelope(frame, options) {
  if (!isRecord(frame.payload) || !("channelId" in frame.payload)) {
    return {
      ok: false,
      error: buildTerminalMuxError("mux_protocol_invalid", "mux frame is missing channelId")
    };
  }
  const channelId = asNonEmptyString(frame.payload.channelId);
  if (!channelId) {
    return {
      ok: false,
      error: buildTerminalMuxError("mux_protocol_invalid", "mux frame has empty channelId")
    };
  }
  const expectedChannelId = asNonEmptyString(options.expectedChannelId);
  if (expectedChannelId && expectedChannelId !== channelId) {
    return {
      ok: false,
      error: buildTerminalMuxError("mux_channel_mismatch", `mux channel ${channelId} does not match expected channel ${expectedChannelId}`, channelId)
    };
  }
  if (!options.hasChannel(channelId)) {
    return {
      ok: false,
      error: buildTerminalMuxError("mux_unknown_channel", `mux channel ${channelId} is not open`, channelId)
    };
  }
  return { ok: true, channelId };
}

// src/server/mirror-lifecycle.ts
function detachMirrorSubscriber(subscribers, sessionId) {
  const nextSubscribers = new Set(subscribers);
  nextSubscribers.delete(sessionId);
  return {
    nextSubscribers,
    remainingSubscribers: nextSubscribers.size,
    shouldReconcileGeometry: nextSubscribers.size > 0,
    keepMirrorAlive: true
  };
}
function releaseMirrorSubscribers(sessions2, subscriberIds) {
  const releasedSessionIds = [];
  for (const sessionId of subscriberIds) {
    const session = sessions2.get(sessionId);
    if (!session) {
      continue;
    }
    session.mirrorKey = null;
    releasedSessionIds.push(sessionId);
  }
  return releasedSessionIds;
}

// ../packages/shared/src/connection/terminal-buffer.ts
function cellsToLine(cells) {
  let line = "";
  for (const cell of cells) {
    if (cell.width === 0) {
      continue;
    }
    line += cell.char >= 32 ? String.fromCodePoint(cell.char) : " ";
  }
  return line.replace(/\s+$/u, "");
}

// src/lib/terminal-buffer-debug.ts
function summarizeIndexedLinesForDebug(lines) {
  const materialized = lines.map((line) => ({
    index: line.index,
    text: cellsToLine(line.cells)
  }));
  if (materialized.length <= 6) {
    return materialized;
  }
  return [
    ...materialized.slice(0, 3),
    { index: -1, text: `\u2026 ${materialized.length - 6} omitted \u2026` },
    ...materialized.slice(-3)
  ];
}

// src/server/terminal-performance-scheduler.ts
var FAST_LANE_DELAY_MS = 16;
var FAST_LANE_MIN_DELAY_MS = 8;
var BACKPRESSURE_BUFFERED_BYTES = 128 * 1024;
var OVERLOADED_CAPTURE_MS = 120;
var SLOW_CAPTURE_MS = 64;
function finiteMs(value, fallback) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value || 0)) : fallback;
}
function resolveTerminalLiveSyncDelay(input) {
  const activeDelayMs = Math.max(1, finiteMs(input.activeDelayMs, 33));
  const idleDelayMs = Math.max(activeDelayMs, finiteMs(input.idleDelayMs, 120));
  const hasExplicitRequestedDelay = typeof input.requestedDelayMs === "number" && Number.isFinite(input.requestedDelayMs);
  const requestedDelayMs = Number.isFinite(input.requestedDelayMs) ? Math.max(0, Math.floor(input.requestedDelayMs || 0)) : activeDelayMs;
  if (hasExplicitRequestedDelay && requestedDelayMs === 0) {
    return { delayMs: 0, lane: "fast", reason: "explicit-immediate" };
  }
  const subscriberCount = Math.max(0, Math.floor(input.subscriberCount || 0));
  if (subscriberCount <= 0) {
    return { delayMs: idleDelayMs, lane: "slow", reason: "no-subscribers" };
  }
  const failureCount = Math.max(0, Math.floor(input.consecutiveFailures || 0));
  if (failureCount > 0) {
    return {
      delayMs: Math.max(idleDelayMs, idleDelayMs * Math.min(failureCount + 1, 11)),
      lane: "slow",
      reason: "failure-backoff"
    };
  }
  if (input.flushInFlight) {
    return {
      delayMs: Math.max(activeDelayMs, FAST_LANE_MIN_DELAY_MS),
      lane: "normal",
      reason: "flush-in-flight"
    };
  }
  const captureCostMs = Math.max(0, Math.floor(input.lastCaptureDurationMs || 0)) + Math.max(0, Math.floor(input.lastCanonicalizeDurationMs || 0));
  if (captureCostMs >= OVERLOADED_CAPTURE_MS) {
    return {
      delayMs: Math.min(1e3, Math.max(idleDelayMs + activeDelayMs, Math.ceil(captureCostMs * 1.25))),
      lane: "overloaded",
      reason: "capture-over-budget"
    };
  }
  const bufferedBytes = Math.max(0, Math.floor(input.transportBufferedBytes || 0));
  const backpressureCount = Math.max(0, Math.floor(input.transportBackpressureCount || 0));
  if (bufferedBytes >= BACKPRESSURE_BUFFERED_BYTES || backpressureCount > 0) {
    return {
      delayMs: Math.max(idleDelayMs, activeDelayMs * (backpressureCount + 2)),
      lane: "slow",
      reason: "transport-backpressure"
    };
  }
  if (captureCostMs >= SLOW_CAPTURE_MS) {
    return {
      delayMs: Math.max(activeDelayMs, Math.ceil(captureCostMs)),
      lane: "normal",
      reason: "capture-normal-budget"
    };
  }
  if (requestedDelayMs <= activeDelayMs && bufferedBytes === 0) {
    return {
      delayMs: Math.min(activeDelayMs, FAST_LANE_DELAY_MS),
      lane: "fast",
      reason: "subscribed-good-transport-low-capture-cost"
    };
  }
  return {
    delayMs: Math.min(requestedDelayMs, activeDelayMs),
    lane: "normal",
    reason: "subscribed-active"
  };
}

// ../node_modules/.pnpm/uuid@9.0.1/node_modules/uuid/dist/esm-node/rng.js
var import_crypto2 = __toESM(require("crypto"));
var rnds8Pool = new Uint8Array(256);
var poolPtr = rnds8Pool.length;
function rng() {
  if (poolPtr > rnds8Pool.length - 16) {
    import_crypto2.default.randomFillSync(rnds8Pool);
    poolPtr = 0;
  }
  return rnds8Pool.slice(poolPtr, poolPtr += 16);
}

// ../node_modules/.pnpm/uuid@9.0.1/node_modules/uuid/dist/esm-node/stringify.js
var byteToHex = [];
for (let i = 0; i < 256; ++i) {
  byteToHex.push((i + 256).toString(16).slice(1));
}
function unsafeStringify(arr, offset = 0) {
  return byteToHex[arr[offset + 0]] + byteToHex[arr[offset + 1]] + byteToHex[arr[offset + 2]] + byteToHex[arr[offset + 3]] + "-" + byteToHex[arr[offset + 4]] + byteToHex[arr[offset + 5]] + "-" + byteToHex[arr[offset + 6]] + byteToHex[arr[offset + 7]] + "-" + byteToHex[arr[offset + 8]] + byteToHex[arr[offset + 9]] + "-" + byteToHex[arr[offset + 10]] + byteToHex[arr[offset + 11]] + byteToHex[arr[offset + 12]] + byteToHex[arr[offset + 13]] + byteToHex[arr[offset + 14]] + byteToHex[arr[offset + 15]];
}

// ../node_modules/.pnpm/uuid@9.0.1/node_modules/uuid/dist/esm-node/native.js
var import_crypto3 = __toESM(require("crypto"));
var native_default = {
  randomUUID: import_crypto3.default.randomUUID
};

// ../node_modules/.pnpm/uuid@9.0.1/node_modules/uuid/dist/esm-node/v4.js
function v4(options, buf, offset) {
  if (native_default.randomUUID && !buf && !options) {
    return native_default.randomUUID();
  }
  options = options || {};
  const rnds = options.random || (options.rng || rng)();
  rnds[6] = rnds[6] & 15 | 64;
  rnds[8] = rnds[8] & 63 | 128;
  if (buf) {
    offset = offset || 0;
    for (let i = 0; i < 16; ++i) {
      buf[offset + i] = rnds[i];
    }
    return buf;
  }
  return unsafeStringify(rnds);
}
var v4_default = v4;

// src/server/terminal-transport-runtime.ts
var TRANSPORT_BACKPRESSURE_BUFFERED_BYTES = 128e3;
var TRANSPORT_BACKPRESSURE_LOW_WATER_BYTES = 64e3;
var TERMINAL_TRANSPORT_STALE_INBOUND_MS = 19e4;
function estimateTransportMessageBytes(text) {
  return Buffer.byteLength(text, "utf8");
}
function readTerminalTransportBackpressureSnapshot(transport) {
  if (!transport) {
    return null;
  }
  const bufferedBytes = Math.max(0, Math.floor(transport.bufferedAmount || 0));
  const backpressure = bufferedBytes >= TRANSPORT_BACKPRESSURE_BUFFERED_BYTES;
  if (backpressure) {
    transport.backpressureCount = Math.max(0, Math.floor(transport.backpressureCount || 0)) + 1;
  } else {
    transport.backpressureCount = 0;
  }
  return {
    kind: transport.kind,
    ready: transport.readyState === import_websocket.default.OPEN,
    bufferedBytes,
    backpressure,
    lowWaterDrained: bufferedBytes <= TRANSPORT_BACKPRESSURE_LOW_WATER_BYTES,
    backpressureCount: Math.max(0, Math.floor(transport.backpressureCount || 0)),
    lastSendBytes: Math.max(0, Math.floor(transport.lastSendBytes || 0)),
    totalSendBytes: Math.max(0, Math.floor(transport.totalSendBytes || 0)),
    lastSendAt: Math.max(0, Math.floor(transport.lastSendAt || 0)),
    lastSendError: transport.lastSendError || null
  };
}
function markTransportConnectionInboundActivity(connection, now = Date.now()) {
  connection.wsAlive = true;
  connection.lastInboundAt = now;
}
function createTerminalTransportRuntime(deps) {
  function createWebSocketSessionTransport2(ws) {
    return {
      kind: "ws",
      requestOrigin: void 0,
      connectedSent: false,
      get readyState() {
        return ws.readyState;
      },
      get bufferedAmount() {
        return Math.max(0, Math.floor(ws.bufferedAmount || 0));
      },
      sendText(text) {
        ws.send(text);
      },
      close(reason) {
        ws.close(1e3, reason);
      },
      ping() {
        ws.ping();
      }
    };
  }
  function createRtcSessionTransport2(transport) {
    return {
      kind: "rtc",
      requestOrigin: void 0,
      connectedSent: false,
      get readyState() {
        return transport.readyState;
      },
      get bufferedAmount() {
        return Math.max(0, Math.floor(transport.bufferedAmount || 0));
      },
      sendText(text) {
        transport.sendText(text);
      },
      close(reason) {
        transport.close(reason);
      }
    };
  }
  function sendTransportMessage2(transport, message) {
    if (!transport || transport.readyState !== import_websocket.default.OPEN) {
      return;
    }
    const text = JSON.stringify(message);
    const bytes = estimateTransportMessageBytes(text);
    try {
      transport.sendText(text);
      transport.lastSendAt = Date.now();
      transport.lastSendBytes = bytes;
      transport.totalSendBytes = Math.max(0, Math.floor(transport.totalSendBytes || 0)) + bytes;
      transport.lastSendError = null;
      readTerminalTransportBackpressureSnapshot(transport);
    } catch (error) {
      transport.lastSendAt = Date.now();
      transport.lastSendBytes = bytes;
      transport.lastSendError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }
  function sendText(transport, text) {
    if (!transport || transport.readyState !== import_websocket.default.OPEN) {
      return;
    }
    const bytes = estimateTransportMessageBytes(text);
    try {
      transport.sendText(text);
      transport.lastSendAt = Date.now();
      transport.lastSendBytes = bytes;
      transport.totalSendBytes = Math.max(0, Math.floor(transport.totalSendBytes || 0)) + bytes;
      transport.lastSendError = null;
      readTerminalTransportBackpressureSnapshot(transport);
    } catch (error) {
      transport.lastSendAt = Date.now();
      transport.lastSendBytes = bytes;
      transport.lastSendError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }
  function sendMessage2(session, message) {
    if (session.transport && session.transport.readyState === import_websocket.default.OPEN) {
      if (message.type === "buffer-sync" || message.type === "connected") {
        deps.daemonRuntimeDebug("send", {
          sessionId: session.id,
          sessionName: session.sessionName,
          type: message.type,
          payloadSummary: deps.summarizePayload(message)
        });
      }
      if (message.type === "buffer-sync") {
        const text = JSON.stringify(message);
        const traceId = `${session.id}:${Math.max(0, Math.floor(message.payload.revision || 0))}`;
        deps.recordPerformanceTrace?.({
          sessionId: session.id,
          traceId,
          mirrorRevision: Math.max(0, Math.floor(message.payload.revision || 0)),
          subscriberId: session.id,
          stage: "send-start",
          at: Date.now(),
          bytes: estimateTransportMessageBytes(text),
          lineCount: Array.isArray(message.payload.lines) ? message.payload.lines.length : 0,
          transportKind: session.transport.kind
        });
        sendText(session.transport, text);
        deps.recordPerformanceTrace?.({
          sessionId: session.id,
          traceId,
          mirrorRevision: Math.max(0, Math.floor(message.payload.revision || 0)),
          subscriberId: session.id,
          stage: "send-done",
          at: Date.now(),
          bytes: estimateTransportMessageBytes(text),
          lineCount: Array.isArray(message.payload.lines) ? message.payload.lines.length : 0,
          transportKind: session.transport.kind
        });
        return;
      }
      sendTransportMessage2(session.transport, message);
    }
  }
  function broadcastRuntimeDebugControl2(enabled, reason, sessionId) {
    for (const session of deps.sessions.values()) {
      if (sessionId && session.id !== sessionId) {
        continue;
      }
      sendMessage2(session, {
        type: "debug-control",
        payload: {
          enabled,
          reason
        }
      });
    }
  }
  function createTransportConnection2(transport, requestOrigin) {
    transport.requestOrigin = requestOrigin;
    transport.connectedSent = false;
    const connection = {
      id: v4_default(),
      transportId: v4_default(),
      transport,
      closeTransport: (reason) => {
        if (transport.readyState < import_websocket.default.CLOSING) {
          transport.close(reason);
        }
      },
      requestOrigin,
      wsAlive: true,
      lastInboundAt: Date.now(),
      role: "pending",
      boundSubscriberId: null
    };
    deps.connections.set(connection.id, connection);
    return connection;
  }
  return {
    createWebSocketSessionTransport: createWebSocketSessionTransport2,
    createRtcSessionTransport: createRtcSessionTransport2,
    sendText,
    sendTransportMessage: sendTransportMessage2,
    sendMessage: sendMessage2,
    broadcastRuntimeDebugControl: broadcastRuntimeDebugControl2,
    createTransportConnection: createTransportConnection2
  };
}

// src/server/terminal-mirror-runtime.ts
var MIRROR_LIVE_SYNC_ACTIVE_MS = 33;
var MIRROR_LIVE_SYNC_IDLE_MS = 120;
var ADAPTIVE_WIDTH_LEASE_TTL_MS = 65e3;
var SUBSCRIBER_PENDING_RANGE_LIMIT = 64;
var SUBSCRIBER_PENDING_SPAN_LINE_LIMIT = 4096;
var SUBSCRIBER_PENDING_AGE_LIMIT_MS = 15e3;
var SUBSCRIBER_BUFFER_SYNC_MAX_BYTES = 128e3;
function getWireLineAbsoluteIndex(line) {
  if (!line) {
    return null;
  }
  if ("i" in line && Number.isFinite(line.i)) {
    return Math.max(0, Math.floor(line.i));
  }
  if ("index" in line && Number.isFinite(line.index)) {
    return Math.max(0, Math.floor(line.index));
  }
  return null;
}
function buildBufferSyncMessageText(payload) {
  return JSON.stringify({ type: "buffer-sync", payload });
}
function splitBufferSyncPayloadMessages(payload, maxBytes) {
  const lines = Array.isArray(payload.lines) ? payload.lines : [];
  const fullText = buildBufferSyncMessageText(payload);
  if (Buffer.byteLength(fullText, "utf8") <= maxBytes || lines.length <= 1) {
    return [{ payload, text: fullText }];
  }
  const messages = [];
  let chunkLines = [];
  let chunkStartIndex = null;
  let chunkEndIndex = null;
  const flushChunk = () => {
    if (chunkLines.length === 0 || chunkStartIndex === null || chunkEndIndex === null) {
      return;
    }
    const chunkPayload = {
      ...payload,
      startIndex: chunkStartIndex,
      endIndex: chunkEndIndex,
      lines: chunkLines
    };
    messages.push({ payload: chunkPayload, text: buildBufferSyncMessageText(chunkPayload) });
    chunkLines = [];
    chunkStartIndex = null;
    chunkEndIndex = null;
  };
  for (const line of lines) {
    const lineIndex = getWireLineAbsoluteIndex(line);
    if (lineIndex === null) {
      continue;
    }
    const candidateStartIndex = chunkStartIndex === null ? lineIndex : chunkStartIndex;
    const candidateEndIndex = Math.max(chunkEndIndex === null ? lineIndex + 1 : chunkEndIndex, lineIndex + 1);
    const candidateLines = [...chunkLines, line];
    const candidatePayload = {
      ...payload,
      startIndex: candidateStartIndex,
      endIndex: candidateEndIndex,
      lines: candidateLines
    };
    const candidateText = buildBufferSyncMessageText(candidatePayload);
    if (chunkLines.length > 0 && Buffer.byteLength(candidateText, "utf8") > maxBytes) {
      flushChunk();
      chunkStartIndex = lineIndex;
      chunkEndIndex = lineIndex + 1;
      chunkLines = [line];
      continue;
    }
    chunkStartIndex = candidateStartIndex;
    chunkEndIndex = candidateEndIndex;
    chunkLines = candidateLines;
  }
  flushChunk();
  return messages.length > 0 ? messages : [{ payload, text: fullText }];
}
function resolvePerSubscriberTransportSnapshot(sessions2, sessionId) {
  const session = sessions2.get(sessionId);
  return readTerminalTransportBackpressureSnapshot(session?.transport);
}
function resolveMirrorLiveSyncDelayForSubscriber(mirror, sessionId, sessions2, now, requestedDelayMs) {
  const snapshot = resolvePerSubscriberTransportSnapshot(sessions2, sessionId);
  return resolveTerminalLiveSyncDelay({
    requestedDelayMs,
    activeDelayMs: MIRROR_LIVE_SYNC_ACTIVE_MS,
    idleDelayMs: MIRROR_LIVE_SYNC_IDLE_MS,
    now,
    lastLiveActivityAt: mirror.lastLiveActivityAt || 0,
    consecutiveFailures: mirror.consecutiveFailures,
    subscriberCount: snapshot?.ready ? 1 : 0,
    transportBufferedBytes: snapshot?.bufferedBytes || 0,
    transportBackpressureCount: snapshot?.backpressureCount || 0,
    lastCaptureDurationMs: mirror.lastCaptureDurationMs || 0,
    lastCanonicalizeDurationMs: mirror.lastCanonicalizeDurationMs || 0,
    flushInFlight: mirror.flushInFlight
  });
}
function createTerminalMirrorRuntime(deps) {
  const sessions2 = deps.sessions;
  const mirrors2 = deps.mirrors;
  const mirrorHeadBroadcastCache = /* @__PURE__ */ new WeakMap();
  function createSubscriberBufferSyncState() {
    return {
      lastSentRevision: 0,
      pendingLatestRevision: null,
      pendingChangedAbsoluteRanges: [],
      pendingSince: 0,
      pendingTransportId: null,
      highWaterActive: false,
      highWaterEnteredAt: 0,
      resyncRequired: false,
      resyncReason: null,
      pendingAllowOversizedTailSeed: false
    };
  }
  function ensureSubscriberBufferSyncState(session) {
    if (!session.bufferSyncState) {
      session.bufferSyncState = createSubscriberBufferSyncState();
    }
    return session.bufferSyncState;
  }
  function normalizeAbsoluteRanges(ranges) {
    return ranges.map((range) => ({
      startIndex: Math.max(0, Math.floor(range.startIndex || 0)),
      endIndex: Math.max(0, Math.floor(range.endIndex || 0))
    })).filter((range) => range.endIndex > range.startIndex).sort((left, right) => left.startIndex - right.startIndex || left.endIndex - right.endIndex);
  }
  function mergeAbsoluteRanges(ranges) {
    const normalized = normalizeAbsoluteRanges(ranges);
    const merged = [];
    for (const range of normalized) {
      const previous = merged[merged.length - 1];
      if (previous && range.startIndex <= previous.endIndex) {
        previous.endIndex = Math.max(previous.endIndex, range.endIndex);
        continue;
      }
      merged.push({ ...range });
    }
    return merged;
  }
  function collapseRangesToSpan(ranges) {
    const normalized = normalizeAbsoluteRanges(ranges);
    if (normalized.length === 0) {
      return [];
    }
    return [{
      startIndex: normalized[0].startIndex,
      endIndex: normalized[normalized.length - 1].endIndex
    }];
  }
  function pendingSpanLineCount(ranges) {
    const normalized = normalizeAbsoluteRanges(ranges);
    if (normalized.length === 0) {
      return 0;
    }
    return normalized[normalized.length - 1].endIndex - normalized[0].startIndex;
  }
  function markSubscriberBufferSyncResyncRequired(state, reason, collapseToSpan) {
    state.resyncRequired = true;
    state.resyncReason = reason;
    if (collapseToSpan) {
      state.pendingChangedAbsoluteRanges = collapseRangesToSpan(state.pendingChangedAbsoluteRanges);
    }
  }
  function validateSubscriberPendingBounds(state, now = Date.now()) {
    if (state.pendingChangedAbsoluteRanges.length > SUBSCRIBER_PENDING_RANGE_LIMIT) {
      markSubscriberBufferSyncResyncRequired(state, "range-count", true);
      return;
    }
    if (pendingSpanLineCount(state.pendingChangedAbsoluteRanges) > SUBSCRIBER_PENDING_SPAN_LINE_LIMIT) {
      markSubscriberBufferSyncResyncRequired(state, "span-lines", true);
      return;
    }
    if (state.pendingSince > 0 && now - state.pendingSince > SUBSCRIBER_PENDING_AGE_LIMIT_MS) {
      markSubscriberBufferSyncResyncRequired(state, "age", false);
    }
  }
  function queueSubscriberPendingBufferSync(session, mirror, changedRanges, now = Date.now(), options) {
    const state = ensureSubscriberBufferSyncState(session);
    const hadPendingRanges = state.pendingChangedAbsoluteRanges.length > 0;
    const nextRanges = mergeAbsoluteRanges([
      ...state.pendingChangedAbsoluteRanges,
      ...changedRanges
    ]);
    if (nextRanges.length === 0) {
      return state;
    }
    state.pendingChangedAbsoluteRanges = nextRanges;
    state.pendingLatestRevision = mirror.revision;
    if (!state.pendingSince) {
      state.pendingSince = now;
    }
    state.pendingAllowOversizedTailSeed = Boolean(options?.allowOversizedTailSeed) && !hadPendingRanges;
    state.pendingTransportId = session.transportId;
    const snapshot = readTerminalTransportBackpressureSnapshot(session.transport);
    if (snapshot?.backpressure) {
      state.highWaterActive = true;
      if (!state.highWaterEnteredAt) {
        state.highWaterEnteredAt = now;
      }
    }
    if (state.pendingChangedAbsoluteRanges.length > SUBSCRIBER_PENDING_RANGE_LIMIT) {
      state.pendingChangedAbsoluteRanges = [{
        startIndex: Math.max(0, Math.floor(mirror.bufferStartIndex || 0)),
        endIndex: Math.max(
          Math.max(0, Math.floor(mirror.bufferStartIndex || 0)),
          Math.floor((mirror.bufferStartIndex || 0) + mirror.bufferLines.length)
        )
      }];
      markSubscriberBufferSyncResyncRequired(state, "range-count", false);
      state.pendingAllowOversizedTailSeed = false;
      return state;
    }
    if (pendingSpanLineCount(state.pendingChangedAbsoluteRanges) > SUBSCRIBER_PENDING_SPAN_LINE_LIMIT) {
      state.pendingChangedAbsoluteRanges = [{
        startIndex: Math.max(0, Math.floor(mirror.bufferStartIndex || 0)),
        endIndex: Math.max(
          Math.max(0, Math.floor(mirror.bufferStartIndex || 0)),
          Math.floor((mirror.bufferStartIndex || 0) + mirror.bufferLines.length)
        )
      }];
      markSubscriberBufferSyncResyncRequired(state, "span-lines", false);
      state.pendingAllowOversizedTailSeed = false;
      return state;
    }
    validateSubscriberPendingBounds(state, now);
    return state;
  }
  function shouldHoldPendingForBackpressure(state, session) {
    const snapshot = readTerminalTransportBackpressureSnapshot(session.transport);
    if (!snapshot?.ready) {
      return true;
    }
    if (snapshot.backpressure) {
      state.highWaterActive = true;
      if (!state.highWaterEnteredAt) {
        state.highWaterEnteredAt = Date.now();
      }
      return true;
    }
    if (state.highWaterActive && !snapshot.lowWaterDrained) {
      return true;
    }
    return false;
  }
  function clearSubscriberPendingBufferSync(state, sentRevision) {
    state.lastSentRevision = sentRevision;
    state.pendingLatestRevision = null;
    state.pendingChangedAbsoluteRanges = [];
    state.pendingSince = 0;
    state.pendingTransportId = null;
    state.highWaterActive = false;
    state.highWaterEnteredAt = 0;
    state.resyncRequired = false;
    state.resyncReason = null;
    state.pendingAllowOversizedTailSeed = false;
  }
  function isTmuxSessionUnavailableError(error) {
    const message = error instanceof Error ? error.message : String(error);
    return /no server running|can(?:'t| not) find session|no such session|session .*not found|wezterm session not found/i.test(message);
  }
  function writeMirrorBaselineGeometry(mirror, geometry) {
    mirror.baselineCols = deps.normalizeTerminalCols(geometry.cols);
    mirror.baselineRows = deps.normalizeTerminalRows(geometry.rows);
  }
  function stopMirrorLiveSync(mirror) {
    if (mirror.liveSyncTimer) {
      clearTimeout(mirror.liveSyncTimer);
      mirror.liveSyncTimer = null;
    }
  }
  function resolveMirrorLiveSyncDelay(mirror, requestedDelayMs) {
    const now = Date.now();
    return resolveTerminalLiveSyncDelay({
      requestedDelayMs,
      activeDelayMs: MIRROR_LIVE_SYNC_ACTIVE_MS,
      idleDelayMs: MIRROR_LIVE_SYNC_IDLE_MS,
      now,
      lastLiveActivityAt: mirror.lastLiveActivityAt || 0,
      consecutiveFailures: mirror.consecutiveFailures,
      subscriberCount: countReadyBodySubscribedSubscribers(mirror),
      // Backpressure is handled per-subscriber in broadcastChangedRangesBufferSyncToSubscribers.
      // Mirror-level capture cadence must not be dragged down by a single slow subscriber.
      transportBufferedBytes: 0,
      transportBackpressureCount: 0,
      lastCaptureDurationMs: mirror.lastCaptureDurationMs || 0,
      lastCanonicalizeDurationMs: mirror.lastCanonicalizeDurationMs || 0,
      flushInFlight: mirror.flushInFlight
    }).delayMs;
  }
  function countReadyBodySubscribedSubscribers(mirror) {
    let count = 0;
    for (const sessionId of mirror.subscribers) {
      const session = sessions2.get(sessionId);
      if (!session || session.bodySubscribed === false) {
        continue;
      }
      if (!session.transport || session.transport.readyState !== 1) {
        continue;
      }
      count += 1;
    }
    return count;
  }
  function createMirror(sessionName) {
    const mirror = {
      key: sessionName,
      sessionName,
      scratchBridge: null,
      lifecycle: "idle",
      cols: deps.defaultViewport.cols,
      rows: deps.defaultViewport.rows,
      baselineCols: deps.defaultViewport.cols,
      baselineRows: deps.defaultViewport.rows,
      cursorKeysApp: false,
      revision: 0,
      lastScrollbackCount: -1,
      bufferStartIndex: 0,
      bufferLines: [],
      cursor: null,
      lastFlushStartedAt: 0,
      lastFlushCompletedAt: 0,
      lastLiveActivityAt: 0,
      lastHeadBroadcastAt: 0,
      lastCaptureDurationMs: 0,
      lastCanonicalizeDurationMs: 0,
      flushInFlight: false,
      flushPromise: null,
      pendingStableCaptureSnapshot: null,
      pendingPerformanceTraceCapture: null,
      adaptiveWidthBaselineGeometry: null,
      adaptiveWidthAppliedCols: null,
      adaptiveWidthLeaseTimer: null,
      liveSyncTimer: null,
      consecutiveFailures: 0,
      subscribers: /* @__PURE__ */ new Set()
    };
    mirrors2.set(sessionName, mirror);
    return mirror;
  }
  function releaseMirrorForSubscribers(mirror, reason, code = "tmux_session_unavailable") {
    const releasedSessionIds = releaseMirrorSubscribers(sessions2, mirror.subscribers);
    for (const sessionId of releasedSessionIds) {
      const client = sessions2.get(sessionId);
      if (!client) {
        continue;
      }
      client.pendingPasteImage = null;
      client.pendingAttachFile = null;
      deps.sendMessage(client, { type: "error", payload: { message: reason, code } });
    }
  }
  function destroyMirror(mirror, reason, options) {
    if (mirror.lifecycle === "destroyed") {
      return;
    }
    deps.disposeLiveMirrorInputBatch(mirror.sessionName, `destroy:${reason}`);
    mirror.lifecycle = "destroyed";
    if (options?.closeTransportSubscribers) {
      const subscriberIds = Array.from(mirror.subscribers);
      for (const sessionId of subscriberIds) {
        const client = sessions2.get(sessionId);
        if (!client) {
          continue;
        }
        deps.closeTransportSubscriber(client, reason, Boolean(options.notifyClientClose));
      }
    } else {
      releaseMirrorForSubscribers(mirror, reason, options?.releaseCode || "tmux_session_unavailable");
    }
    mirror.subscribers.clear();
    mirror.scratchBridge = null;
    mirror.bufferLines = [];
    mirror.bufferStartIndex = 0;
    mirror.cursor = null;
    mirror.lastFlushStartedAt = 0;
    mirror.lastFlushCompletedAt = 0;
    mirror.lastLiveActivityAt = 0;
    mirror.lastHeadBroadcastAt = 0;
    mirror.lastCaptureDurationMs = 0;
    mirror.lastCanonicalizeDurationMs = 0;
    mirror.lastScrollbackCount = -1;
    mirror.flushInFlight = false;
    mirror.flushPromise = null;
    mirror.pendingStableCaptureSnapshot = null;
    mirror.pendingPerformanceTraceCapture = null;
    if (mirror.adaptiveWidthLeaseTimer) {
      clearTimeout(mirror.adaptiveWidthLeaseTimer);
      mirror.adaptiveWidthLeaseTimer = null;
    }
    mirror.adaptiveWidthBaselineGeometry = null;
    mirror.adaptiveWidthAppliedCols = null;
    stopMirrorLiveSync(mirror);
    mirrors2.delete(mirror.key);
  }
  function ensureSessionReady(session, mirror) {
    session.sessionName = mirror.sessionName;
    if (!session.transport || session.connectedSent) {
      return;
    }
    session.connectedSent = true;
    session.transport.connectedSent = true;
    deps.sendMessage(session, {
      type: "connected",
      payload: deps.buildConnectedPayload(session.id, session.transport.requestOrigin)
    });
    deps.sendScheduleStateToSession(session, mirror.sessionName);
    deps.sendMessage(session, { type: "title", payload: mirror.sessionName });
  }
  function announceMirrorSubscribersReady(mirror) {
    for (const sessionId of mirror.subscribers) {
      const session = sessions2.get(sessionId);
      if (!session) {
        continue;
      }
      ensureSessionReady(session, mirror);
    }
  }
  function broadcastBufferHeadToSubscribers(mirror) {
    const now = Date.now();
    mirror.lastHeadBroadcastAt = now;
    mirrorHeadBroadcastCache.set(mirror, { revision: mirror.revision });
    for (const sessionId of mirror.subscribers) {
      const session = sessions2.get(sessionId);
      if (!session || !session.transport || session.transport.readyState !== 1) {
        continue;
      }
      const snapshot = readTerminalTransportBackpressureSnapshot(session.transport);
      if (snapshot && snapshot.backpressure) {
        continue;
      }
      ensureSessionReady(session, mirror);
      deps.sendMessage(session, {
        type: "buffer-head",
        payload: deps.buildBufferHeadPayload(session.id, mirror)
      });
    }
  }
  function broadcastChangedRangesBufferSyncToSubscribers(mirror, changedRanges, options) {
    const normalizedRanges = normalizeAbsoluteRanges(changedRanges);
    if (normalizedRanges.length === 0) {
      return;
    }
    const now = Date.now();
    for (const sessionId of mirror.subscribers) {
      const session = sessions2.get(sessionId);
      if (!session) {
        continue;
      }
      if (session.bodySubscribed === false) {
        continue;
      }
      queueSubscriberPendingBufferSync(session, mirror, normalizedRanges, now, options);
      flushPendingSubscriberBufferSync(mirror, sessionId);
    }
  }
  function flushPendingSubscriberBufferSync(mirror, sessionId) {
    const session = sessions2.get(sessionId);
    if (!session) {
      return "missing-subscriber";
    }
    const state = ensureSubscriberBufferSyncState(session);
    if (state.pendingLatestRevision === null || state.pendingChangedAbsoluteRanges.length === 0) {
      return "no-pending";
    }
    if (state.pendingTransportId && state.pendingTransportId !== session.transportId) {
      markSubscriberBufferSyncResyncRequired(state, "transport-generation", false);
      return "stale-transport";
    }
    validateSubscriberPendingBounds(state);
    if (!session.transport || session.transport.readyState !== 1) {
      return "transport-not-open";
    }
    if (shouldHoldPendingForBackpressure(state, session)) {
      return "backpressured";
    }
    const payload = deps.buildChangedRangesBufferSyncPayload(
      mirror,
      state.pendingChangedAbsoluteRanges
    );
    if (!payload) {
      clearSubscriberPendingBufferSync(state, Math.max(state.lastSentRevision, state.pendingLatestRevision));
      return "no-pending";
    }
    let messages = splitBufferSyncPayloadMessages(payload, SUBSCRIBER_BUFFER_SYNC_MAX_BYTES);
    if (messages.length > 1 && state.pendingAllowOversizedTailSeed) {
      const tailPayload = buildLiveTailBufferSyncPayload(mirror, { viewportRows: mirror.rows });
      messages = [{ payload: tailPayload, text: buildBufferSyncMessageText(tailPayload) }];
    }
    const traceId = `${session.id}:${Math.max(0, Math.floor(payload.revision || 0))}`;
    const traceBase = {
      sessionId: session.id,
      traceId,
      mirrorRevision: Math.max(0, Math.floor(payload.revision || 0)),
      subscriberId: session.id,
      transportKind: session.transport.kind
    };
    try {
      ensureSessionReady(session, mirror);
      for (const message of messages) {
        deps.recordPerformanceTrace?.({
          ...traceBase,
          stage: "send-start",
          at: Date.now(),
          bytes: Buffer.byteLength(message.text, "utf8"),
          lineCount: Array.isArray(message.payload.lines) ? message.payload.lines.length : 0
        });
        deps.sendText(session.transport, message.text);
        deps.recordPerformanceTrace?.({
          ...traceBase,
          stage: "send-done",
          at: Date.now(),
          bytes: Buffer.byteLength(message.text, "utf8"),
          lineCount: Array.isArray(message.payload.lines) ? message.payload.lines.length : 0
        });
      }
    } catch {
      return "send-error";
    }
    clearSubscriberPendingBufferSync(state, payload.revision);
    return "sent";
  }
  function flushPendingBufferSyncToSubscribers(mirror) {
    for (const sessionId of mirror.subscribers) {
      const session = sessions2.get(sessionId);
      if (session?.bodySubscribed === false) {
        continue;
      }
      flushPendingSubscriberBufferSync(mirror, sessionId);
    }
  }
  function sendBufferHeadToSession(session, mirror) {
    if (!session.transport || session.transport.readyState !== 1) {
      return;
    }
    const cached = mirrorHeadBroadcastCache.get(mirror);
    if (cached?.revision !== mirror.revision) {
      broadcastBufferHeadToSubscribers(mirror);
      return;
    }
    deps.sendMessage(session, {
      type: "buffer-head",
      payload: deps.buildBufferHeadPayload(session.id, mirror)
    });
  }
  async function refreshMirrorHeadForSession(session, mirror) {
    if (mirror.lifecycle !== "ready") {
      return false;
    }
    const captured = await syncMirrorCanonicalBuffer(mirror);
    if (!captured) {
      return false;
    }
    sendBufferHeadToSession(session, mirror);
    return true;
  }
  async function syncMirrorCanonicalBuffer(mirror, options) {
    if (mirror.lifecycle !== "ready") {
      return false;
    }
    if (mirror.flushPromise) {
      return mirror.flushPromise;
    }
    const previousStartIndex = mirror.bufferStartIndex;
    const previousLines = mirror.bufferLines.slice();
    const previousCursor = mirror.cursor ? { ...mirror.cursor } : null;
    const previousCursorKeysApp = mirror.cursorKeysApp;
    const forceRevision = Boolean(options?.forceRevision);
    mirror.lastFlushStartedAt = Date.now();
    mirror.flushInFlight = true;
    const capturePromise = deps.captureMirrorAuthoritativeBufferFromTmux(mirror).then((captured) => {
      if (!captured) {
        throw new Error("tmux capture returned no canonical buffer");
      }
      writeMirrorBaselineGeometry(mirror, {
        cols: mirror.cols,
        rows: mirror.rows
      });
      mirror.consecutiveFailures = 0;
      const changedRanges = deps.mirrorBufferChanged(mirror, previousStartIndex, previousLines);
      const cursorChanged = !deps.mirrorCursorEqual(previousCursor, mirror.cursor);
      const cursorKeysAppChanged = previousCursorKeysApp !== mirror.cursorKeysApp;
      const hasLiveActivity = forceRevision || changedRanges.length > 0 || cursorChanged || cursorKeysAppChanged;
      if (hasLiveActivity) {
        mirror.revision += 1;
        mirror.lastLiveActivityAt = Date.now();
      }
      if (hasLiveActivity) {
        const captureTrace = mirror.pendingPerformanceTraceCapture;
        const committedAt = Date.now();
        for (const subscriberId of mirror.subscribers) {
          const traceBase = {
            sessionId: subscriberId,
            traceId: `${subscriberId}:${Math.max(0, Math.floor(mirror.revision || 0))}`,
            mirrorRevision: Math.max(0, Math.floor(mirror.revision || 0)),
            subscriberId
          };
          if (captureTrace) {
            deps.recordPerformanceTrace?.({
              ...traceBase,
              stage: "capture-start",
              at: captureTrace.captureStartedAt,
              lineCount: captureTrace.capturedLineCount
            });
            deps.recordPerformanceTrace?.({
              ...traceBase,
              stage: "capture-done",
              at: captureTrace.captureDoneAt,
              lineCount: captureTrace.capturedLineCount
            });
            deps.recordPerformanceTrace?.({
              ...traceBase,
              stage: "canonicalize-done",
              at: captureTrace.canonicalizeDoneAt,
              lineCount: captureTrace.canonicalLineCount
            });
          }
          deps.recordPerformanceTrace?.({
            ...traceBase,
            stage: "mirror-commit",
            at: committedAt,
            lineCount: mirror.bufferLines.length
          });
        }
      }
      if (changedRanges.length > 0 || cursorChanged || cursorKeysAppChanged || forceRevision) {
        const firstRange = changedRanges[0] || null;
        const lastRange = changedRanges[changedRanges.length - 1] || null;
        console.debug(`[${deps.logTimePrefix()}] mirror.flush.inspect`, {
          sessionName: mirror.sessionName,
          revision: mirror.revision,
          previousStartIndex,
          previousEndIndex: previousStartIndex + previousLines.length,
          nextStartIndex: mirror.bufferStartIndex,
          nextEndIndex: mirror.bufferStartIndex + mirror.bufferLines.length,
          changedRangeCount: changedRanges.length,
          firstChangedRange: firstRange,
          lastChangedRange: lastRange,
          cursorChanged,
          cursorKeysAppChanged,
          forceRevision,
          changedLinePreview: firstRange ? summarizeIndexedLinesForDebug(
            sliceIndexedLines(
              mirror.bufferStartIndex,
              mirror.bufferLines,
              firstRange.startIndex,
              Math.min(firstRange.endIndex, firstRange.startIndex + 6)
            )
          ) : []
        });
      }
      if (changedRanges.length > 0 || forceRevision) {
        broadcastChangedRangesBufferSyncToSubscribers(
          mirror,
          forceRevision ? [{ startIndex: mirror.bufferStartIndex, endIndex: mirror.bufferStartIndex + mirror.bufferLines.length }] : changedRanges,
          { allowOversizedTailSeed: forceRevision && changedRanges.length === 0 }
        );
        return true;
      }
      if (cursorChanged || cursorKeysAppChanged) {
        broadcastBufferHeadToSubscribers(mirror);
      }
      flushPendingBufferSyncToSubscribers(mirror);
      return true;
    }).catch((error) => {
      mirror.consecutiveFailures += 1;
      const isInvalidTarget = isTmuxSessionUnavailableError(error);
      const failureMsg = `[${deps.logTimePrefix()}] canonical mirror refresh failed for ${mirror.sessionName} (streak=${mirror.consecutiveFailures}): ${error instanceof Error ? error.message : String(error)}`;
      if (isInvalidTarget) {
        console.error(`${failureMsg} -> mirror released (code=tmux_session_unavailable)`);
        destroyMirror(
          mirror,
          `Tmux session unavailable: ${error instanceof Error ? error.message : String(error)}`,
          {
            closeTransportSubscribers: false,
            releaseCode: "tmux_session_unavailable"
          }
        );
        return false;
      }
      if (mirror.consecutiveFailures >= 10) {
        mirror.lifecycle = "failed";
        stopMirrorLiveSync(mirror);
        console.error(`${failureMsg} -> mirror isolated (lifecycle=failed)`);
      } else {
        console.error(failureMsg);
      }
      return false;
    }).finally(() => {
      mirror.lastFlushCompletedAt = Date.now();
      mirror.flushInFlight = false;
      mirror.flushPromise = null;
    });
    mirror.flushPromise = capturePromise;
    return capturePromise;
  }
  function scheduleMirrorLiveSync(mirror, delayMs = MIRROR_LIVE_SYNC_ACTIVE_MS) {
    if (mirror.lifecycle !== "ready") {
      return;
    }
    if (countReadyBodySubscribedSubscribers(mirror) === 0) {
      stopMirrorLiveSync(mirror);
      return;
    }
    const effectiveDelay = resolveMirrorLiveSyncDelay(mirror, delayMs);
    stopMirrorLiveSync(mirror);
    mirror.liveSyncTimer = setTimeout(() => {
      mirror.liveSyncTimer = null;
      if (mirror.lifecycle !== "ready" || countReadyBodySubscribedSubscribers(mirror) === 0) {
        return;
      }
      void syncMirrorCanonicalBuffer(mirror).finally(() => {
        if (mirror.lifecycle !== "ready" || mirror.liveSyncTimer || countReadyBodySubscribedSubscribers(mirror) === 0) {
          return;
        }
        scheduleMirrorLiveSync(mirror, MIRROR_LIVE_SYNC_ACTIVE_MS);
      });
    }, Math.max(0, effectiveDelay));
  }
  function resolveActiveAdaptiveWidthLeases(mirror, now = Date.now()) {
    const leases = [];
    for (const subscriberId of mirror.subscribers) {
      const subscriber = sessions2.get(subscriberId);
      if (!subscriber || !subscriber.transport || subscriber.transport.readyState !== 1) {
        continue;
      }
      if (!subscriber.adaptiveWidthCols || subscriber.adaptiveWidthCols <= 0) {
        continue;
      }
      const expiresAt = (subscriber.adaptiveWidthHeartbeatAt || 0) + ADAPTIVE_WIDTH_LEASE_TTL_MS;
      if (expiresAt <= now) {
        continue;
      }
      leases.push({
        subscriberId,
        cols: deps.normalizeTerminalCols(subscriber.adaptiveWidthCols),
        expiresAt
      });
    }
    leases.sort((left, right) => left.cols - right.cols || left.expiresAt - right.expiresAt);
    return leases;
  }
  function scheduleAdaptiveWidthLeaseExpiry(mirror) {
    if (mirror.adaptiveWidthLeaseTimer) {
      clearTimeout(mirror.adaptiveWidthLeaseTimer);
      mirror.adaptiveWidthLeaseTimer = null;
    }
    const leases = resolveActiveAdaptiveWidthLeases(mirror);
    if (leases.length === 0) {
      return;
    }
    const nextExpiresAt = Math.min(...leases.map((lease) => lease.expiresAt));
    const delayMs = Math.max(1, nextExpiresAt - Date.now() + 1);
    mirror.adaptiveWidthLeaseTimer = setTimeout(() => {
      mirror.adaptiveWidthLeaseTimer = null;
      reconcileAdaptiveWidthLeases(mirror, "lease-expired");
    }, delayMs);
    mirror.adaptiveWidthLeaseTimer.unref?.();
  }
  function clearAdaptiveWidthLeaseAggregate(mirror, reason = "clear") {
    if (mirror.adaptiveWidthLeaseTimer) {
      clearTimeout(mirror.adaptiveWidthLeaseTimer);
      mirror.adaptiveWidthLeaseTimer = null;
    }
    if (mirror.adaptiveWidthAppliedCols !== null) {
      releaseAdaptiveTmuxWidth(mirror, reason);
    }
    mirror.adaptiveWidthAppliedCols = null;
    mirror.adaptiveWidthBaselineGeometry = null;
  }
  function readCurrentTmuxGeometry(sessionName) {
    try {
      const metrics = deps.readTmuxPaneMetrics(sessionName);
      return {
        cols: deps.normalizeTerminalCols(metrics.paneCols),
        rows: deps.normalizeTerminalRows(metrics.paneRows)
      };
    } catch (error) {
      console.error(
        `[${deps.logTimePrefix()}] adaptive width failed to read tmux geometry for ${sessionName}: ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }
  }
  function applyAdaptiveTmuxWidth(mirror, targetCols, reason) {
    const cols = deps.normalizeTerminalCols(targetCols);
    if (!mirror.adaptiveWidthBaselineGeometry) {
      mirror.adaptiveWidthBaselineGeometry = readCurrentTmuxGeometry(mirror.sessionName) || {
        cols: deps.normalizeTerminalCols(mirror.baselineCols || mirror.cols),
        rows: deps.normalizeTerminalRows(mirror.baselineRows || mirror.rows)
      };
    }
    if (mirror.adaptiveWidthAppliedCols === cols) {
      return;
    }
    deps.runTmux(["resize-window", "-t", mirror.sessionName, "-x", String(cols)]);
    mirror.adaptiveWidthAppliedCols = cols;
    console.log(`[${deps.logTimePrefix()}] adaptive width applied`, {
      sessionName: mirror.sessionName,
      cols,
      reason
    });
  }
  function releaseAdaptiveTmuxWidth(mirror, reason) {
    const baseline = mirror.adaptiveWidthBaselineGeometry;
    if (baseline) {
      deps.runTmux(["resize-window", "-t", mirror.sessionName, "-x", String(deps.normalizeTerminalCols(baseline.cols))]);
    }
    deps.runTmux(["set-window-option", "-u", "-t", mirror.sessionName, "window-size"]);
    console.log(`[${deps.logTimePrefix()}] adaptive width released`, {
      sessionName: mirror.sessionName,
      restoredCols: baseline?.cols ?? null,
      reason
    });
  }
  function reconcileAdaptiveWidthLeases(mirror, reason) {
    void reason;
    const now = Date.now();
    for (const subscriberId of mirror.subscribers) {
      const subscriber = sessions2.get(subscriberId);
      if (!subscriber?.adaptiveWidthCols) {
        continue;
      }
      const expiresAt = (subscriber.adaptiveWidthHeartbeatAt || 0) + ADAPTIVE_WIDTH_LEASE_TTL_MS;
      if (expiresAt <= now) {
        subscriber.adaptiveWidthCols = null;
        subscriber.adaptiveWidthHeartbeatAt = 0;
      }
    }
    const leases = resolveActiveAdaptiveWidthLeases(mirror);
    if (leases.length === 0) {
      clearAdaptiveWidthLeaseAggregate(mirror, reason);
      return;
    }
    const targetCols = leases[0].cols;
    if (mirror.adaptiveWidthAppliedCols !== targetCols) {
      if (mirror.lifecycle === "ready") {
        applyAdaptiveTmuxWidth(mirror, targetCols, reason);
        scheduleMirrorLiveSync(mirror, 0);
      }
    }
    scheduleAdaptiveWidthLeaseExpiry(mirror);
  }
  function updateAdaptiveWidthLease(session, mirror, payload, reason) {
    if (payload.widthMode !== "adaptive-phone") {
      releaseAdaptiveWidthLease(session, reason);
      return { ok: true };
    }
    if (typeof payload.cols !== "number" || !Number.isFinite(payload.cols) || payload.cols <= 0) {
      releaseAdaptiveWidthLease(session, `${reason}-invalid-cols`);
      return {
        ok: false,
        code: "adaptive_width_cols_invalid",
        message: "adaptive-phone width lease requires finite positive cols"
      };
    }
    const cols = deps.normalizeTerminalCols(payload.cols);
    session.adaptiveWidthCols = cols;
    session.adaptiveWidthHeartbeatAt = Date.now();
    reconcileAdaptiveWidthLeases(mirror, reason);
    return { ok: true };
  }
  function restorePersistedAdaptiveWidthBaselines(sessionNames) {
    void sessionNames;
    return 0;
  }
  async function startMirror(mirror, options) {
    if (mirror.lifecycle === "ready" || mirror.lifecycle === "booting") {
      return;
    }
    mirror.lifecycle = "booting";
    try {
      deps.assertTmuxSessionExists(mirror.sessionName);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      mirror.lifecycle = "failed";
      for (const sessionId of mirror.subscribers) {
        const session = sessions2.get(sessionId);
        if (!session) {
          continue;
        }
        deps.sendMessage(session, {
          type: "error",
          payload: { message: `Tmux session unavailable: ${message}`, code: "tmux_session_unavailable" }
        });
      }
      return;
    }
    mirror.lifecycle = "ready";
    reconcileAdaptiveWidthLeases(mirror, "mirror-ready");
    if (countReadyBodySubscribedSubscribers(mirror) === 0) {
      announceMirrorSubscribersReady(mirror);
      return;
    }
    try {
      await deps.waitMs(80);
      const captured = await syncMirrorCanonicalBuffer(mirror, { forceRevision: true });
      if (!captured) {
        if (!mirrors2.has(mirror.key)) {
          return;
        }
        throw new Error("Failed to capture canonical tmux buffer during initial sync");
      }
      announceMirrorSubscribersReady(mirror);
      scheduleMirrorLiveSync(mirror, MIRROR_LIVE_SYNC_ACTIVE_MS);
    } catch (error) {
      if (isTmuxSessionUnavailableError(error)) {
        console.error(
          `[${deps.logTimePrefix()}] initial buffer sync released unavailable tmux target for ${mirror.sessionName}: ${error instanceof Error ? error.message : String(error)}`
        );
        destroyMirror(
          mirror,
          `Tmux session unavailable: ${error instanceof Error ? error.message : String(error)}`,
          {
            closeTransportSubscribers: false,
            releaseCode: "tmux_session_unavailable"
          }
        );
        return;
      }
      mirror.lifecycle = "failed";
      console.error(
        `[${deps.logTimePrefix()}] initial buffer sync failed for ${mirror.sessionName}: ${error instanceof Error ? error.message : String(error)}`
      );
      for (const sessionId of mirror.subscribers) {
        const subscriber = sessions2.get(sessionId);
        if (!subscriber) {
          continue;
        }
        deps.sendMessage(subscriber, {
          type: "error",
          payload: {
            message: `Initial canonical sync failed: ${error instanceof Error ? error.message : String(error)}`,
            code: "initial_buffer_sync_failed"
          }
        });
      }
    }
    if (options?.autoCommand?.trim()) {
      const command = options.autoCommand.endsWith("\r") ? options.autoCommand.slice(0, -1) : options.autoCommand;
      setTimeout(() => {
        if (mirror.lifecycle === "ready") {
          deps.writeToTmuxSession(mirror.sessionName, command, true);
          scheduleMirrorLiveSync(mirror, 0);
        }
      }, deps.autoCommandDelayMs);
    }
  }
  async function attachTmux(session, payload) {
    const nextSessionName = deps.sanitizeSessionName(payload.sessionName);
    const nextMirrorKey = deps.getMirrorKey(nextSessionName);
    const existingMirror = mirrors2.get(nextMirrorKey) || null;
    const existingTmuxGeometry = existingMirror ? null : (() => {
      try {
        const metrics = deps.readTmuxPaneMetrics(nextSessionName);
        return {
          cols: metrics.paneCols,
          rows: metrics.paneRows
        };
      } catch (metricsError) {
        console.warn(
          "[server] readTmuxPaneMetrics failed:",
          metricsError instanceof Error ? metricsError.message : metricsError
        );
        return null;
      }
    })();
    const requestedGeometry = deps.resolveAttachGeometry({
      requestedGeometry: payload.widthMode === "adaptive-phone" ? null : typeof payload.cols === "number" && Number.isFinite(payload.cols) && payload.cols > 0 ? {
        cols: payload.cols,
        rows: typeof payload.rows === "number" ? payload.rows : deps.defaultViewport.rows
      } : null,
      currentMirrorGeometry: existingMirror ? { cols: existingMirror.cols, rows: existingMirror.rows } : null,
      existingTmuxGeometry,
      previousSessionGeometry: deps.defaultViewport
    });
    const requestedCols = deps.normalizeTerminalCols(requestedGeometry.cols);
    const requestedRows = deps.normalizeTerminalRows(requestedGeometry.rows);
    const previousMirror = deps.getSessionMirror(session);
    const movingBetweenMirrors = Boolean(previousMirror && previousMirror.key !== nextMirrorKey);
    if (previousMirror) {
      if (movingBetweenMirrors) {
        releaseAdaptiveWidthLease(session, "move-mirror");
      }
      const detachResult = detachMirrorSubscriber(previousMirror.subscribers, session.id);
      previousMirror.subscribers = detachResult.nextSubscribers;
      if (movingBetweenMirrors) {
        scheduleMirrorLiveSync(previousMirror, MIRROR_LIVE_SYNC_ACTIVE_MS);
      }
    }
    session.sessionName = nextSessionName;
    session.mirrorKey = nextMirrorKey;
    session.connectedSent = false;
    if (session.transport) {
      session.transport.connectedSent = false;
    }
    let mirror = existingMirror;
    if (!mirror) {
      mirror = createMirror(nextSessionName);
    }
    mirror.subscribers.add(session.id);
    if (payload.widthMode === "adaptive-phone") {
      const leaseResult = updateAdaptiveWidthLease(session, mirror, payload, "attach");
      if (!leaseResult.ok) {
        deps.sendMessage(session, {
          type: "error",
          payload: { message: leaseResult.message, code: leaseResult.code }
        });
      }
    } else {
      releaseAdaptiveWidthLease(session, "attach-non-adaptive");
    }
    deps.sendMessage(session, { type: "title", payload: mirror.sessionName });
    if (mirror.lifecycle === "ready") {
      ensureSessionReady(session, mirror);
      scheduleMirrorLiveSync(mirror, 0);
      return;
    }
    await startMirror(mirror, { cols: requestedCols, rows: requestedRows, autoCommand: payload.autoCommand });
  }
  function handleAdaptiveResize(session, payload) {
    const mirror = deps.getSessionMirror(session);
    if (!mirror) {
      return {
        ok: false,
        code: "session_not_ready",
        message: "resize requires an attached mirror"
      };
    }
    const leaseResult = updateAdaptiveWidthLease(session, mirror, payload, "resize");
    if (!leaseResult.ok) {
      return leaseResult;
    }
    scheduleMirrorLiveSync(mirror, 0);
    return { ok: true };
  }
  function refreshAdaptiveWidthLeaseHeartbeat(session) {
    if (!session.adaptiveWidthCols || !session.mirrorKey) {
      return;
    }
    const mirror = deps.getSessionMirror(session);
    if (!mirror) {
      return;
    }
    session.adaptiveWidthHeartbeatAt = Date.now();
    scheduleAdaptiveWidthLeaseExpiry(mirror);
  }
  function releaseAdaptiveWidthLease(session, reason) {
    const mirror = deps.getSessionMirror(session);
    const hadLease = Boolean(session.adaptiveWidthCols);
    session.adaptiveWidthCols = null;
    session.adaptiveWidthHeartbeatAt = 0;
    if (!mirror || !hadLease) {
      return;
    }
    reconcileAdaptiveWidthLeases(mirror, reason);
  }
  async function handleInput(session, data, shouldWrite) {
    const mirror = deps.getSessionMirror(session);
    if (!mirror) {
      return false;
    }
    if (mirror.lifecycle === "failed") {
      mirror.lifecycle = "ready";
      mirror.consecutiveFailures = 0;
      console.log(`[${deps.logTimePrefix()}] mirror ${mirror.sessionName} recovered from failed by input`);
    }
    if (mirror.lifecycle === "ready") {
      mirror.consecutiveFailures = 0;
      const wrote = await deps.enqueueLiveMirrorInput(mirror.sessionName, data, false, shouldWrite);
      if (wrote) {
        mirror.lastLiveActivityAt = Date.now();
        scheduleMirrorLiveSync(mirror, 0);
        return true;
      }
    }
    return false;
  }
  return {
    createMirror,
    destroyMirror,
    ensureSessionReady,
    sendBufferHeadToSession,
    flushPendingSubscriberBufferSync,
    refreshMirrorHeadForSession,
    syncMirrorCanonicalBuffer,
    scheduleMirrorLiveSync,
    resolveMirrorLiveSyncDelayForSubscriber,
    startMirror,
    attachTmux,
    handleAdaptiveResize,
    restorePersistedAdaptiveWidthBaselines,
    refreshAdaptiveWidthLeaseHeartbeat,
    releaseAdaptiveWidthLease,
    handleInput,
    disposeLiveMirrorInputBatch: (sessionName, reason) => deps.disposeLiveMirrorInputBatch(sessionName, `destroy:${reason}`)
  };
}

// src/server/terminal-runtime.ts
function createTerminalRuntime(deps) {
  const sessions2 = deps.sessions;
  const mirrors2 = deps.mirrors;
  function createTransportSubscriber(connection) {
    connection.transport.requestOrigin = connection.requestOrigin;
    connection.transport.connectedSent = false;
    const subscriber = {
      id: connection.transportId,
      transportId: connection.transportId,
      transport: connection.transport,
      closeTransport: connection.closeTransport,
      connectedSent: false,
      muxChannelId: null,
      muxParentTransportId: null,
      sessionName: deps.defaultSessionName,
      mirrorKey: null,
      bodySubscribed: true,
      adaptiveWidthCols: null,
      adaptiveWidthHeartbeatAt: 0,
      pendingPasteImage: null,
      pendingAttachFile: null
    };
    sessions2.set(subscriber.id, subscriber);
    connection.role = "session";
    connection.boundSubscriberId = subscriber.id;
    return subscriber;
  }
  function createMuxChannelTransport(connection, channelId) {
    return {
      kind: connection.transport.kind,
      requestOrigin: connection.requestOrigin,
      connectedSent: false,
      get readyState() {
        return connection.transport.readyState;
      },
      get bufferedAmount() {
        return Math.max(0, Math.floor(connection.transport.bufferedAmount || 0));
      },
      sendText(text) {
        let message;
        try {
          message = JSON.parse(text);
        } catch {
          deps.sendText(connection.transport, JSON.stringify({
            type: "mux-error",
            payload: {
              code: "mux_protocol_invalid",
              message: "mux channel send requires a JSON server message",
              channelId
            }
          }));
          return;
        }
        deps.sendText(
          connection.transport,
          JSON.stringify(buildTerminalMuxServerChannelMessage(channelId, message))
        );
      },
      close() {
        deps.sendText(connection.transport, JSON.stringify({
          type: "mux-channel-closed",
          payload: {
            channelId,
            reason: "server closed channel transport"
          }
        }));
      }
    };
  }
  function createMuxChannelSubscriber(connection, channelId) {
    const normalizedChannelId = channelId.trim();
    const subscriberId = `${connection.transportId}:${normalizedChannelId}`;
    const subscriber = {
      id: subscriberId,
      transportId: connection.transportId,
      transport: createMuxChannelTransport(connection, normalizedChannelId),
      closeTransport: (reason) => {
        deps.sendText(connection.transport, JSON.stringify({
          type: "mux-channel-closed",
          payload: {
            channelId: normalizedChannelId,
            reason
          }
        }));
      },
      connectedSent: false,
      muxChannelId: normalizedChannelId,
      muxParentTransportId: connection.transportId,
      sessionName: deps.defaultSessionName,
      mirrorKey: null,
      bodySubscribed: true,
      adaptiveWidthCols: null,
      adaptiveWidthHeartbeatAt: 0,
      pendingPasteImage: null,
      pendingAttachFile: null
    };
    sessions2.set(subscriber.id, subscriber);
    connection.role = "session";
    connection.boundSubscriberId = null;
    if (!connection.muxChannels) {
      connection.muxChannels = /* @__PURE__ */ new Map();
    }
    connection.muxChannels.set(normalizedChannelId, subscriber.id);
    return subscriber;
  }
  function getTransportSubscriber(subscriberId) {
    return sessions2.get(subscriberId) || null;
  }
  function getMirrorByKey(mirrorKey) {
    return mirrors2.get(mirrorKey) || null;
  }
  function getSubscriberMirror(subscriber) {
    if (!subscriber.mirrorKey) {
      return null;
    }
    return mirrors2.get(subscriber.mirrorKey) || null;
  }
  function bindConnectionToSubscriber(connection, subscriber) {
    subscriber.id = connection.transportId;
    subscriber.transportId = connection.transportId;
    subscriber.transport = connection.transport;
    subscriber.closeTransport = connection.closeTransport;
    subscriber.connectedSent = false;
    subscriber.muxChannelId = null;
    subscriber.muxParentTransportId = null;
    subscriber.bodySubscribed = true;
    connection.transport.requestOrigin = connection.requestOrigin;
    connection.transport.connectedSent = false;
    connection.role = "session";
    connection.boundSubscriberId = subscriber.id;
    const mirror = getSubscriberMirror(subscriber);
    if (mirror?.lifecycle === "ready") {
      mirrorRuntime.scheduleMirrorLiveSync(mirror, 0);
    }
    return subscriber;
  }
  function detachSubscriberTransportOnly(subscriber, reason, transportId) {
    const current = sessions2.get(subscriber.id);
    if (!current || current !== subscriber) {
      return;
    }
    if (transportId && subscriber.transportId !== transportId) {
      return;
    }
    subscriber.transport = null;
    subscriber.closeTransport = void 0;
    subscriber.pendingPasteImage = null;
    subscriber.pendingAttachFile = null;
    deps.daemonRuntimeDebug("transport-detached", {
      sessionId: subscriber.id,
      sessionName: subscriber.sessionName,
      type: "closed",
      payload: { reason }
    });
    const mirror = getSubscriberMirror(subscriber);
    if (mirror) {
      mirrorRuntime.releaseAdaptiveWidthLease(subscriber, `detach:${reason}`);
      const detachResult = detachMirrorSubscriber(mirror.subscribers, subscriber.id);
      mirror.subscribers = detachResult.nextSubscribers;
      deps.disposeLiveMirrorInputBatch(mirror.sessionName, `detach:${reason}`);
      if (mirror.subscribers.size > 0) {
        mirrorRuntime.scheduleMirrorLiveSync(mirror);
      }
    }
    subscriber.mirrorKey = null;
    sessions2.delete(subscriber.id);
  }
  function closeTransportSubscriber(subscriber, reason, notifyClient = false) {
    const current = sessions2.get(subscriber.id);
    if (!current || current !== subscriber) {
      return;
    }
    const mirror = getSubscriberMirror(subscriber);
    if (mirror) {
      mirrorRuntime.releaseAdaptiveWidthLease(subscriber, `close:${reason}`);
      const detachResult = detachMirrorSubscriber(mirror.subscribers, subscriber.id);
      mirror.subscribers = detachResult.nextSubscribers;
      deps.disposeLiveMirrorInputBatch(mirror.sessionName, `close:${reason}`);
      if (mirror.subscribers.size > 0) {
        mirrorRuntime.scheduleMirrorLiveSync(mirror);
      }
    }
    if (notifyClient) {
      deps.sendMessage(subscriber, { type: "closed", payload: { reason } });
    }
    if (subscriber.transport && subscriber.transport.readyState < import_websocket.default.CLOSING) {
      try {
        subscriber.transport.close(reason);
      } catch (error) {
        console.warn(
          `[${deps.logTimePrefix()}] failed to close transport subscriber ${subscriber.id}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    subscriber.transport = null;
    subscriber.closeTransport = void 0;
    subscriber.pendingPasteImage = null;
    subscriber.pendingAttachFile = null;
    subscriber.mirrorKey = null;
    sessions2.delete(subscriber.id);
  }
  const mirrorRuntime = createTerminalMirrorRuntime({
    defaultViewport: deps.defaultViewport,
    sessions: sessions2,
    mirrors: mirrors2,
    sendMessage: deps.sendMessage,
    sendText: deps.sendText,
    recordPerformanceTrace: deps.recordPerformanceTrace,
    sendScheduleStateToSession: deps.sendScheduleStateToSession,
    buildConnectedPayload: deps.buildConnectedPayload,
    buildBufferHeadPayload: deps.buildBufferHeadPayload,
    buildChangedRangesBufferSyncPayload: deps.buildChangedRangesBufferSyncPayload,
    sanitizeSessionName: deps.sanitizeSessionName,
    getMirrorKey: deps.getMirrorKey,
    normalizeTerminalCols: deps.normalizeTerminalCols,
    normalizeTerminalRows: deps.normalizeTerminalRows,
    resolveAttachGeometry: deps.resolveAttachGeometry,
    readTmuxPaneMetrics: deps.readTmuxPaneMetrics,
    assertTmuxSessionExists: deps.assertTmuxSessionExists,
    captureMirrorAuthoritativeBufferFromTmux: deps.captureMirrorAuthoritativeBufferFromTmux,
    mirrorBufferChanged: deps.mirrorBufferChanged,
    mirrorCursorEqual: deps.mirrorCursorEqual,
    writeToLiveMirror: deps.writeToLiveMirror,
    enqueueLiveMirrorInput: deps.enqueueLiveMirrorInput,
    disposeLiveMirrorInputBatch: deps.disposeLiveMirrorInputBatch,
    writeToTmuxSession: deps.writeToTmuxSession,
    autoCommandDelayMs: deps.autoCommandDelayMs,
    waitMs: deps.waitMs,
    logTimePrefix: deps.logTimePrefix,
    runTmux: deps.runTmux,
    closeTransportSubscriber,
    getSessionMirror: getSubscriberMirror
  });
  return {
    sessions: () => sessions2,
    mirrors: () => mirrors2,
    getTransportSubscriber,
    getMirrorByKey,
    createMirror: mirrorRuntime.createMirror,
    getSubscriberMirror,
    createTransportSubscriber,
    createMuxChannelSubscriber,
    bindConnectionToSubscriber,
    detachSubscriberTransportOnly,
    closeTransportSubscriber,
    destroyMirror: mirrorRuntime.destroyMirror,
    disposeLiveMirrorInputBatch: (sessionName, reason) => mirrorRuntime.disposeLiveMirrorInputBatch(sessionName, reason),
    ensureSessionReady: mirrorRuntime.ensureSessionReady,
    sendBufferHeadToSession: mirrorRuntime.sendBufferHeadToSession,
    refreshMirrorHeadForSession: mirrorRuntime.refreshMirrorHeadForSession,
    syncMirrorCanonicalBuffer: mirrorRuntime.syncMirrorCanonicalBuffer,
    scheduleMirrorLiveSync: mirrorRuntime.scheduleMirrorLiveSync,
    startMirror: mirrorRuntime.startMirror,
    attachTmux: mirrorRuntime.attachTmux,
    handleAdaptiveResize: mirrorRuntime.handleAdaptiveResize,
    restorePersistedAdaptiveWidthBaselines: mirrorRuntime.restorePersistedAdaptiveWidthBaselines,
    refreshAdaptiveWidthLeaseHeartbeat: mirrorRuntime.refreshAdaptiveWidthLeaseHeartbeat,
    handleInput: mirrorRuntime.handleInput
  };
}

// src/server/terminal-file-transfer-binary-runtime.ts
var import_fs3 = require("fs");
var import_path3 = require("path");
function createTerminalFileTransferBinaryRuntime(deps) {
  const pendingUploads = /* @__PURE__ */ new Map();
  function sanitizeUploadFileName(input) {
    const generatedName = `upload-${Date.now()}`;
    const candidate = (input || generatedName).trim() || generatedName;
    return candidate.replace(/[^a-zA-Z0-9._-]/g, "-");
  }
  function ensureUploadDir() {
    (0, import_fs3.mkdirSync)(deps.uploadDir, { recursive: true });
  }
  function normalizeImageToPng(inputPath, preferredBaseName) {
    ensureUploadDir();
    const outputPath = (0, import_path3.join)(deps.uploadDir, `${preferredBaseName}-${Date.now()}.png`);
    deps.runCommand("sips", ["-s", "format", "png", inputPath, "--out", outputPath]);
    return outputPath;
  }
  function writeImageToClipboard(pngPath) {
    deps.runCommand("osascript", [
      "-e",
      `set f to POSIX file "${pngPath.replace(/"/g, '\\"')}"`,
      "-e",
      "set the clipboard to (read f as \xABclass PNGf\xBB)"
    ]);
  }
  function logCleanupFailure(scope, filePath, error) {
    console.warn(
      `[${deps.logTimePrefix()}] ${scope} cleanup failed for ${filePath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  function persistClipboardImageBuffer(fileMeta, buffer) {
    ensureUploadDir();
    const safeName = sanitizeUploadFileName(fileMeta.name || "upload");
    const explicitExt = (0, import_path3.extname)(safeName);
    const sourceExt = explicitExt || (fileMeta.mimeType === "image/jpeg" ? ".jpg" : fileMeta.mimeType === "image/png" ? ".png" : fileMeta.mimeType === "image/gif" ? ".gif" : "");
    const sourcePath = (0, import_path3.join)(deps.uploadDir, `${safeName.replace(/\.[^.]+$/u, "")}-${Date.now()}${sourceExt}`);
    (0, import_fs3.writeFileSync)(sourcePath, buffer);
    const pngPath = normalizeImageToPng(sourcePath, safeName.replace(/\.[^.]+$/u, ""));
    writeImageToClipboard(pngPath);
    return { sourcePath, pngPath, bytes: buffer.byteLength };
  }
  function persistClipboardImage(payload) {
    return persistClipboardImageBuffer(
      {
        name: payload.name,
        mimeType: payload.mimeType
      },
      Buffer.from(payload.dataBase64, "base64")
    );
  }
  function consumePendingBinaryTransfer(pending, buffer) {
    if (!pending) {
      return { pending: null, complete: null, error: null };
    }
    pending.chunks.push(buffer);
    pending.receivedBytes += buffer.length;
    if (pending.receivedBytes > pending.payload.byteLength) {
      return {
        pending: null,
        complete: null,
        error: `Binary payload exceeded expected size (${pending.receivedBytes} > ${pending.payload.byteLength})`
      };
    }
    if (pending.receivedBytes < pending.payload.byteLength) {
      return { pending, complete: null, error: null };
    }
    return {
      pending: null,
      complete: Buffer.concat(pending.chunks, pending.payload.byteLength),
      error: null
    };
  }
  function cleanupClipboardImageFiles(sourcePath, pngPath) {
    try {
      (0, import_fs3.unlinkSync)(sourcePath);
    } catch (error) {
      logCleanupFailure("paste-image", sourcePath, error);
    }
    try {
      (0, import_fs3.unlinkSync)(pngPath);
    } catch (error) {
      logCleanupFailure("paste-image", pngPath, error);
    }
  }
  function sendImagePasted(session, payload, bytes) {
    deps.sendMessage(session, {
      type: "image-pasted",
      payload: {
        name: payload.name,
        mimeType: payload.mimeType,
        bytes
      }
    });
  }
  function sendImagePasteError(session, message) {
    deps.sendMessage(session, {
      type: "error",
      payload: { message: `Failed to paste image: ${message}`, code: "paste_image_failed" }
    });
  }
  function emitImagePaste(session, payload, bufferFactory) {
    try {
      const { sourcePath, pngPath, bytes } = bufferFactory();
      if (payload.pasteTarget?.kind === "remote-window") {
        if (!deps.pasteImageToRemoteWindow) {
          cleanupClipboardImageFiles(sourcePath, pngPath);
          sendImagePasteError(session, "remote window image paste is not available");
          return;
        }
        void Promise.resolve(deps.pasteImageToRemoteWindow(session, payload.pasteTarget, {
          name: payload.name,
          mimeType: payload.mimeType,
          bytes
        })).then(() => {
          sendImagePasted(session, payload, bytes);
          cleanupClipboardImageFiles(sourcePath, pngPath);
        }).catch((error) => {
          cleanupClipboardImageFiles(sourcePath, pngPath);
          sendImagePasteError(session, error instanceof Error ? error.message : String(error));
        });
        return;
      }
      const mirror = deps.getSessionMirror(session);
      if (!mirror || mirror.lifecycle !== "ready") {
        cleanupClipboardImageFiles(sourcePath, pngPath);
        deps.sendMessage(session, {
          type: "error",
          payload: { message: "Session is not ready for image paste", code: "session_not_ready" }
        });
        return;
      }
      const pasteSequence = payload.pasteSequence || "";
      deps.writeToLiveMirror(mirror.sessionName, pasteSequence, false);
      deps.scheduleMirrorLiveSync(mirror, 33);
      sendImagePasted(session, payload, bytes);
      cleanupClipboardImageFiles(sourcePath, pngPath);
    } catch (error) {
      sendImagePasteError(session, error instanceof Error ? error.message : String(error));
    }
  }
  function handlePasteImage(session, payload) {
    emitImagePaste(session, payload, () => persistClipboardImage(payload));
  }
  function handleFileUploadStart(session, payload) {
    const { requestId, targetDir, fileName, fileSize, chunkCount } = payload;
    (0, import_fs3.mkdirSync)(targetDir, { recursive: true });
    pendingUploads.set(requestId, {
      targetDir,
      fileName,
      fileSize,
      chunks: /* @__PURE__ */ new Map(),
      totalChunks: chunkCount,
      receivedChunks: 0
    });
    deps.sendMessage(session, {
      type: "file-upload-progress",
      payload: { requestId, chunkIndex: 0, totalChunks: chunkCount }
    });
  }
  function handleFileUploadChunk(session, payload) {
    const { requestId, chunkIndex, dataBase64 } = payload;
    const upload = pendingUploads.get(requestId);
    if (!upload) {
      deps.sendMessage(session, { type: "file-upload-error", payload: { requestId, error: "No pending upload" } });
      return;
    }
    upload.chunks.set(chunkIndex, Buffer.from(dataBase64, "base64"));
    upload.receivedChunks += 1;
    deps.sendMessage(session, {
      type: "file-upload-progress",
      payload: { requestId, chunkIndex: upload.receivedChunks, totalChunks: upload.totalChunks }
    });
  }
  function handleFileUploadEnd(session, payload) {
    const { requestId } = payload;
    const upload = pendingUploads.get(requestId);
    if (!upload) {
      deps.sendMessage(session, { type: "file-upload-error", payload: { requestId, error: "No pending upload" } });
      return;
    }
    try {
      const sortedChunks = [];
      for (let i = 0; i < upload.totalChunks; i += 1) {
        const chunk = upload.chunks.get(i);
        if (!chunk) {
          throw new Error(`Missing chunk ${i}`);
        }
        sortedChunks.push(chunk);
      }
      const filePath = (0, import_path3.join)(upload.targetDir, upload.fileName);
      const fileBuffer = Buffer.concat(sortedChunks);
      (0, import_fs3.writeFileSync)(filePath, fileBuffer);
      deps.sendMessage(session, {
        type: "file-upload-complete",
        payload: { requestId, filePath, bytes: fileBuffer.length }
      });
    } catch (error) {
      deps.sendMessage(session, {
        type: "file-upload-error",
        payload: { requestId, error: error instanceof Error ? error.message : String(error) }
      });
    } finally {
      pendingUploads.delete(requestId);
    }
  }
  function handleAttachFileBinary(session, buffer) {
    const pendingTransfer = session.pendingAttachFile;
    const consume = consumePendingBinaryTransfer(pendingTransfer, buffer);
    session.pendingAttachFile = consume.pending;
    if (!pendingTransfer) {
      deps.sendMessage(session, {
        type: "error",
        payload: { message: "No pending attach-file when binary arrived", code: "attach_file_no_pending" }
      });
      return;
    }
    if (consume.error) {
      deps.sendMessage(session, {
        type: "error",
        payload: { message: consume.error, code: "attach_file_size_mismatch" }
      });
      return;
    }
    if (!consume.complete) {
      return;
    }
    const mirror = deps.getSessionMirror(session);
    if (!mirror || mirror.lifecycle !== "ready") {
      deps.sendMessage(session, {
        type: "error",
        payload: { message: "Session is not ready for file attach", code: "session_not_ready" }
      });
      return;
    }
    try {
      const payload = pendingTransfer.payload;
      (0, import_fs3.mkdirSync)(deps.downloadsDir, { recursive: true });
      const targetPath = (0, import_path3.join)(deps.downloadsDir, payload.name);
      (0, import_fs3.writeFileSync)(targetPath, consume.complete);
      deps.writeToTmuxSession(mirror.sessionName, targetPath, true);
      deps.scheduleMirrorLiveSync(mirror, 33);
      deps.sendMessage(session, {
        type: "file-attached",
        payload: {
          name: payload.name,
          path: targetPath,
          bytes: consume.complete.length
        }
      });
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      deps.sendMessage(session, {
        type: "error",
        payload: { message: `Failed to attach file: ${err}`, code: "attach_file_failed" }
      });
    }
  }
  function handlePasteImageBinary(session, buffer) {
    const pendingTransfer = session.pendingPasteImage;
    const consume = consumePendingBinaryTransfer(pendingTransfer, buffer);
    session.pendingPasteImage = consume.pending;
    if (!pendingTransfer) {
      deps.sendMessage(session, {
        type: "error",
        payload: { message: "No pending paste-image when binary arrived", code: "paste_image_no_pending" }
      });
      return;
    }
    if (consume.error) {
      deps.sendMessage(session, {
        type: "error",
        payload: { message: consume.error, code: "paste_image_size_mismatch" }
      });
      return;
    }
    if (!consume.complete) {
      return;
    }
    const pending = pendingTransfer.payload;
    emitImagePaste(session, pending, () => persistClipboardImageBuffer(
      {
        name: pending.name,
        mimeType: pending.mimeType
      },
      consume.complete
    ));
  }
  function handleBinaryPayload(session, buffer) {
    if (session.pendingAttachFile) {
      handleAttachFileBinary(session, buffer);
      return;
    }
    handlePasteImageBinary(session, buffer);
  }
  return {
    handlePasteImage,
    handleFileUploadStart,
    handleFileUploadChunk,
    handleFileUploadEnd,
    handleBinaryPayload
  };
}

// src/server/terminal-file-transfer-list-runtime.ts
var import_fs4 = require("fs");
var import_path4 = require("path");

// src/server/file-transfer-path.ts
var import_node_path = require("node:path");
function resolveFileTransferListPath(requestedPath, readCurrentSessionPath) {
  const trimmedRequestedPath = typeof requestedPath === "string" ? requestedPath.trim() : "";
  if (trimmedRequestedPath) {
    return (0, import_node_path.resolve)(trimmedRequestedPath);
  }
  const currentSessionPath = readCurrentSessionPath().trim();
  if (!currentSessionPath) {
    throw new Error("tmux pane current path unavailable");
  }
  return (0, import_node_path.resolve)(currentSessionPath);
}

// src/server/remote-screenshot.ts
var DAEMON_CAPTURE_UNAVAILABLE_PATTERN = /daemon screenshot capture unavailable/i;
var NO_DISPLAY_PATTERN = /could not create image from display/i;
var PERMISSION_PATTERN = /(not permitted|operation not permitted|screen recording|screen capture permission (restricted|denied|not-determined))/i;
function resolveRemoteScreenshotErrorMessage(error, timeoutMs) {
  if (error && typeof error === "object" && "killed" in error && error.killed) {
    return `remote screenshot timed out after ${timeoutMs}ms`;
  }
  const rawMessage = error instanceof Error ? error.message : typeof error === "string" ? error : String(error || "remote screenshot failed");
  if (DAEMON_CAPTURE_UNAVAILABLE_PATTERN.test(rawMessage)) {
    return "zterm-daemon \u622A\u56FE\u80FD\u529B\u4E0D\u53EF\u7528\uFF0C\u8BF7\u91CD\u65B0\u8FD0\u884C zterm-daemon install-service \u5E76\u5B8C\u6210\u622A\u56FE\u6743\u9650\u6388\u6743";
  }
  if (PERMISSION_PATTERN.test(rawMessage)) {
    return "zterm-daemon \u7F3A\u5C11\u7CFB\u7EDF\u622A\u56FE\u6743\u9650\uFF0C\u8BF7\u5728 Mac \u7CFB\u7EDF\u8BBE\u7F6E -> \u9690\u79C1\u4E0E\u5B89\u5168\u6027 -> \u5C4F\u5E55\u4E0E\u7CFB\u7EDF\u97F3\u9891\u5F55\u5236 \u4E2D\u5141\u8BB8 zterm-daemon\uFF0C\u7136\u540E\u91CD\u65B0\u8FD0\u884C zterm-daemon install-service";
  }
  if (NO_DISPLAY_PATTERN.test(rawMessage)) {
    return "zterm-daemon \u5F53\u524D\u65E0\u6CD5\u4ECE\u663E\u793A\u5668\u521B\u5EFA\u622A\u56FE";
  }
  return rawMessage || "remote screenshot failed";
}

// src/server/terminal-file-transfer-types.ts
var FILE_CHUNK_SIZE = 256 * 1024;
var REMOTE_SCREENSHOT_CAPTURE_TIMEOUT_MS = 15e3;

// src/server/terminal-file-transfer-list-runtime.ts
function logFileTransferRuntimeError(scope, error, context) {
  console.error(`[terminal-file-transfer-list-runtime] ${scope}`, {
    error: error instanceof Error ? error.message : String(error),
    ...context
  });
}
function createTerminalFileTransferListRuntime(deps) {
  function sendFileDownloadBuffer(session, requestId, fileName, fileBuffer) {
    const totalChunks = Math.ceil(fileBuffer.length / FILE_CHUNK_SIZE);
    let index = 0;
    function sendNextChunk() {
      if (index >= totalChunks) {
        deps.sendMessage(session, {
          type: "file-download-complete",
          payload: { requestId, fileName, totalBytes: fileBuffer.length }
        });
        return;
      }
      const start = index * FILE_CHUNK_SIZE;
      const end = Math.min(start + FILE_CHUNK_SIZE, fileBuffer.length);
      const chunk = fileBuffer.subarray(start, end);
      deps.sendMessage(session, {
        type: "file-download-chunk",
        payload: {
          requestId,
          chunkIndex: index,
          totalChunks,
          fileName,
          dataBase64: chunk.toString("base64")
        }
      });
      index += 1;
      setImmediate(sendNextChunk);
    }
    sendNextChunk();
  }
  function buildRemoteScreenshotFileName(prefix = "remote-screenshot") {
    const now = /* @__PURE__ */ new Date();
    const pad = (value) => String(value).padStart(2, "0");
    const safePrefix = prefix.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "remote-screenshot";
    return `${safePrefix}-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.png`;
  }
  function normalizeRemoteScreenshotRect(rect, label) {
    if (!rect) {
      throw new Error(`${label} requires a capture rectangle`);
    }
    const values = [rect.x, rect.y, rect.width, rect.height];
    if (!values.every((value) => Number.isFinite(value))) {
      throw new Error(`${label} capture rectangle is invalid`);
    }
    const normalized = {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    };
    if (normalized.width <= 0 || normalized.height <= 0) {
      throw new Error(`${label} capture rectangle must have positive size`);
    }
    if (normalized.width > 2e4 || normalized.height > 2e4) {
      throw new Error(`${label} capture rectangle is too large`);
    }
    return normalized;
  }
  function resolveRemoteScreenshotCaptureRequest(payload) {
    const targetPayload = payload.target;
    if (!targetPayload) {
      return {
        fileName: buildRemoteScreenshotFileName()
      };
    }
    if (targetPayload.kind !== "remote-window" || !targetPayload.target) {
      throw new Error("remote screenshot target is invalid");
    }
    const target = targetPayload.target;
    const title = target.videoTarget.title || target.videoTarget.appBundleId || target.streamTargetId || "window";
    if (target.videoTarget.kind === "app-window") {
      const windowId = String(target.videoTarget.windowId || "").trim();
      if (!/^\d+$/u.test(windowId)) {
        throw new Error("remote window screenshot requires a numeric macOS window id");
      }
      return {
        fileName: buildRemoteScreenshotFileName(`remote-window-screenshot-${title}`),
        windowId
      };
    }
    return {
      fileName: buildRemoteScreenshotFileName(`remote-window-screenshot-${title}`),
      rect: normalizeRemoteScreenshotRect(
        target.videoTarget.cropRectTopLeftPx,
        "remote window pane screenshot"
      )
    };
  }
  function handleFileListRequest(session, payload) {
    const { requestId, path: requestedPath, showHidden } = payload;
    try {
      const resolvedPath = resolveFileTransferListPath(
        requestedPath,
        () => deps.readTmuxPaneCurrentPath(session.sessionName)
      );
      const entries = (0, import_fs4.readdirSync)(resolvedPath, { withFileTypes: true });
      const fileEntries = [];
      for (const entry of entries) {
        if (!showHidden && entry.name.startsWith(".")) {
          continue;
        }
        try {
          const stats = (0, import_fs4.statSync)((0, import_path4.join)(resolvedPath, entry.name));
          fileEntries.push({
            name: entry.name,
            type: entry.isDirectory() ? "directory" : "file",
            size: entry.isDirectory() ? 0 : stats.size,
            modified: stats.mtimeMs
          });
        } catch (error) {
          logFileTransferRuntimeError("stat entry failed", error, {
            sessionName: session.sessionName,
            path: resolvedPath,
            entryName: entry.name
          });
        }
      }
      fileEntries.sort((a, b) => {
        if (a.type !== b.type) {
          return a.type === "directory" ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });
      const parentPath = resolvedPath === "/" ? null : (0, import_path4.resolve)(resolvedPath, "..");
      deps.sendMessage(session, {
        type: "file-list-response",
        payload: { requestId, path: resolvedPath, parentPath, entries: fileEntries }
      });
    } catch (error) {
      deps.sendMessage(session, {
        type: "file-list-error",
        payload: { requestId, error: error instanceof Error ? error.message : String(error) }
      });
    }
  }
  function handleFileCreateDirectoryRequest(session, payload) {
    const { requestId, path: requestedPath, name: requestedName } = payload;
    try {
      const resolvedPath = resolveFileTransferListPath(
        requestedPath,
        () => deps.readTmuxPaneCurrentPath(session.sessionName)
      );
      const directoryName = requestedName.trim();
      if (!directoryName) {
        throw new Error("directory name required");
      }
      if (directoryName === "." || directoryName === ".." || directoryName.includes("/") || directoryName.includes("\\")) {
        throw new Error("invalid directory name");
      }
      (0, import_fs4.mkdirSync)((0, import_path4.join)(resolvedPath, directoryName), { recursive: false });
      deps.sendMessage(session, {
        type: "file-create-directory-complete",
        payload: { requestId, path: resolvedPath, name: directoryName }
      });
    } catch (error) {
      deps.sendMessage(session, {
        type: "file-create-directory-error",
        payload: { requestId, error: error instanceof Error ? error.message : String(error) }
      });
    }
  }
  function handleFileDownloadRequest(session, payload) {
    const { requestId, remotePath, fileName } = payload;
    try {
      if (!(0, import_fs4.existsSync)(remotePath)) {
        deps.sendMessage(session, {
          type: "file-download-error",
          payload: { requestId, error: "File not found" }
        });
        return;
      }
      const fileBuffer = (0, import_fs4.readFileSync)(remotePath);
      sendFileDownloadBuffer(session, requestId, fileName, fileBuffer);
    } catch (error) {
      deps.sendMessage(session, {
        type: "file-download-error",
        payload: { requestId, error: error instanceof Error ? error.message : String(error) }
      });
    }
  }
  async function handleRemoteScreenshotRequest(session, payload) {
    const requestId = typeof payload.requestId === "string" ? payload.requestId.trim() : "";
    if (!requestId) {
      deps.sendMessage(session, {
        type: "file-download-error",
        payload: { requestId: "", error: "remote-screenshot-request missing requestId" }
      });
      return;
    }
    if (deps.platform !== "darwin") {
      deps.sendMessage(session, {
        type: "file-download-error",
        payload: { requestId, error: `Remote screenshot unsupported on platform: ${deps.platform}` }
      });
      return;
    }
    let captureRequest;
    try {
      captureRequest = resolveRemoteScreenshotCaptureRequest(payload);
    } catch (error) {
      deps.sendMessage(session, {
        type: "file-download-error",
        payload: { requestId, error: error instanceof Error ? error.message : String(error) }
      });
      return;
    }
    const fileName = captureRequest.fileName;
    const tempPath = (0, import_path4.join)(deps.wtermHomeDir, fileName);
    deps.sendMessage(session, {
      type: "remote-screenshot-status",
      payload: { requestId, phase: "capturing", fileName }
    });
    (0, import_fs4.mkdirSync)(deps.wtermHomeDir, { recursive: true });
    try {
      const captureResult = await deps.captureRemoteScreenshot({
        outputPath: tempPath,
        timeoutMs: REMOTE_SCREENSHOT_CAPTURE_TIMEOUT_MS,
        ...captureRequest.windowId ? { windowId: captureRequest.windowId } : {},
        ...captureRequest.rect ? { rect: captureRequest.rect } : {}
      });
      const fileBuffer = (0, import_fs4.readFileSync)(captureResult.outputPath);
      deps.sendMessage(session, {
        type: "remote-screenshot-status",
        payload: {
          requestId,
          phase: "transferring",
          fileName,
          receivedChunks: 0,
          totalChunks: Math.max(1, Math.ceil(fileBuffer.length / FILE_CHUNK_SIZE)),
          totalBytes: fileBuffer.length
        }
      });
      sendFileDownloadBuffer(session, requestId, fileName, fileBuffer);
    } catch (error) {
      deps.sendMessage(session, {
        type: "file-download-error",
        payload: {
          requestId,
          error: resolveRemoteScreenshotErrorMessage(error, REMOTE_SCREENSHOT_CAPTURE_TIMEOUT_MS)
        }
      });
    } finally {
      try {
        if ((0, import_fs4.existsSync)(tempPath)) {
          (0, import_fs4.unlinkSync)(tempPath);
        }
      } catch (error) {
        logFileTransferRuntimeError("remote screenshot cleanup failed", error, {
          sessionName: session.sessionName,
          path: tempPath
        });
      }
    }
  }
  return {
    handleFileListRequest,
    handleFileCreateDirectoryRequest,
    handleFileDownloadRequest,
    handleRemoteScreenshotRequest
  };
}

// src/server/terminal-file-transfer-runtime.ts
function createTerminalFileTransferRuntime(deps) {
  const listRuntime = createTerminalFileTransferListRuntime(deps);
  const binaryRuntime = createTerminalFileTransferBinaryRuntime(deps);
  return {
    handlePasteImage: binaryRuntime.handlePasteImage,
    handleFileListRequest: listRuntime.handleFileListRequest,
    handleFileCreateDirectoryRequest: listRuntime.handleFileCreateDirectoryRequest,
    handleFileDownloadRequest: listRuntime.handleFileDownloadRequest,
    handleRemoteScreenshotRequest: listRuntime.handleRemoteScreenshotRequest,
    handleFileUploadStart: binaryRuntime.handleFileUploadStart,
    handleFileUploadChunk: binaryRuntime.handleFileUploadChunk,
    handleFileUploadEnd: binaryRuntime.handleFileUploadEnd,
    handleBinaryPayload: binaryRuntime.handleBinaryPayload
  };
}

// ../packages/shared/src/terminal/input-chunking.ts
var TERMINAL_INPUT_CHUNK_BYTES = 64 * 1024;
var TERMINAL_INPUT_DAEMON_FRAME_MAX_BYTES = 256 * 1024;
var TERMINAL_INPUT_TMUX_WRITE_CHUNK_BYTES = 256;
var TERMINAL_INPUT_TMUX_WRITE_SETTLE_MS = 2;
function getTerminalInputUtf8ByteLength(input) {
  return new TextEncoder().encode(input).byteLength;
}
function getCodePointUtf8ByteLength(codePoint) {
  if (codePoint <= 127) return 1;
  if (codePoint <= 2047) return 2;
  if (codePoint <= 65535) return 3;
  return 4;
}
function splitTerminalInputUtf8Chunks(input, maxChunkBytes = TERMINAL_INPUT_CHUNK_BYTES) {
  if (!Number.isFinite(maxChunkBytes) || maxChunkBytes < 4) {
    throw new Error("terminal input chunk size must be at least 4 UTF-8 bytes");
  }
  if (!input) {
    return [];
  }
  const chunks = [];
  let current = "";
  let currentBytes = 0;
  for (let index = 0; index < input.length; ) {
    const codePoint = input.codePointAt(index);
    if (codePoint === void 0) {
      break;
    }
    const text = String.fromCodePoint(codePoint);
    const bytes = getCodePointUtf8ByteLength(codePoint);
    if (currentBytes > 0 && currentBytes + bytes > maxChunkBytes) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += text;
    currentBytes += bytes;
    index += text.length;
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
}

// ../packages/shared/src/schedule/next-fire.ts
var DEFAULT_TIMEZONE = "UTC";
var WEEKDAY_SET = /* @__PURE__ */ new Set([1, 2, 3, 4, 5]);
var MIN_INTERVAL_MS = 1e3;
var DEFAULT_MAX_RUNS = 3;
function parseIsoDateParts(input) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(input.trim());
  if (!match) {
    return null;
  }
  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return null;
  }
  return { year, month, day };
}
function parseTimeParts(input) {
  const match = /^(\d{1,2}):(\d{2})$/u.exec(input.trim());
  if (!match) {
    return null;
  }
  const hour = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2], 10);
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  return { hour, minute };
}
function getFormatter(timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short"
  });
}
var WEEKDAY_TO_INDEX = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6
};
function getZonedParts(date, timeZone) {
  const formatter = getFormatter(timeZone);
  const parts = formatter.formatToParts(date);
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const weekday = WEEKDAY_TO_INDEX[lookup.weekday] ?? 0;
  return {
    year: Number.parseInt(lookup.year, 10),
    month: Number.parseInt(lookup.month, 10),
    day: Number.parseInt(lookup.day, 10),
    hour: Number.parseInt(lookup.hour, 10),
    minute: Number.parseInt(lookup.minute, 10),
    second: Number.parseInt(lookup.second, 10),
    weekday
  };
}
function compareWallDateTime(left, right) {
  const leftStamp = Date.UTC(left.year, left.month - 1, left.day, left.hour, left.minute, left.second || 0);
  const rightStamp = Date.UTC(right.year, right.month - 1, right.day, right.hour, right.minute, right.second || 0);
  return leftStamp - rightStamp;
}
function addUtcDays(parts, days) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 0, 0, 0));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate()
  };
}
function wallTimeToUtc(wall, timeZone) {
  let guess = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second || 0);
  for (let iteration = 0; iteration < 6; iteration += 1) {
    const parts = getZonedParts(new Date(guess), timeZone);
    const actual = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    const desired = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second || 0);
    const delta = desired - actual;
    guess += delta;
    if (delta === 0) {
      break;
    }
  }
  const finalParts = getZonedParts(new Date(guess), timeZone);
  if (finalParts.year !== wall.year || finalParts.month !== wall.month || finalParts.day !== wall.day || finalParts.hour !== wall.hour || finalParts.minute !== wall.minute) {
    return null;
  }
  return new Date(guess);
}
function normalizeWeekdays(rule) {
  if (rule.repeat === "weekdays") {
    return Array.from(WEEKDAY_SET);
  }
  if (rule.repeat === "custom") {
    return Array.from(new Set((rule.weekdays || []).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))).sort((a, b) => a - b);
  }
  if (rule.repeat === "weekly") {
    const dateParts = parseIsoDateParts(rule.date);
    if (!dateParts) {
      return [];
    }
    const weekday = new Date(Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day)).getUTCDay();
    return [weekday];
  }
  return [];
}
function resolveNextAlarmFireAt(rule, now) {
  const timezone = rule.timezone || DEFAULT_TIMEZONE;
  const dateParts = parseIsoDateParts(rule.date);
  const timeParts = parseTimeParts(rule.time);
  if (!dateParts || !timeParts) {
    return void 0;
  }
  if (rule.repeat === "once") {
    const candidate = wallTimeToUtc({ ...dateParts, ...timeParts, second: 0 }, timezone);
    return candidate && candidate.getTime() > now.getTime() ? candidate.toISOString() : void 0;
  }
  const zonedNow = getZonedParts(now, timezone);
  const allowedWeekdays = normalizeWeekdays(rule);
  for (let dayOffset = 0; dayOffset <= 14; dayOffset += 1) {
    const candidateDate = addUtcDays(
      { year: zonedNow.year, month: zonedNow.month, day: zonedNow.day },
      dayOffset
    );
    const weekday = new Date(Date.UTC(candidateDate.year, candidateDate.month - 1, candidateDate.day)).getUTCDay();
    if (rule.repeat === "daily") {
    } else if (rule.repeat === "weekdays" || rule.repeat === "custom" || rule.repeat === "weekly") {
      if (!allowedWeekdays.includes(weekday)) {
        continue;
      }
    }
    const candidateWall = { ...candidateDate, ...timeParts, second: 0 };
    if (dayOffset === 0 && compareWallDateTime(candidateWall, zonedNow) <= 0) {
      continue;
    }
    const candidate = wallTimeToUtc(candidateWall, timezone);
    if (candidate && candidate.getTime() > now.getTime()) {
      return candidate.toISOString();
    }
  }
  return void 0;
}
function resolveNextIntervalFireAt(job, now) {
  if (job.rule.kind !== "interval") {
    return void 0;
  }
  const intervalMs = Math.max(MIN_INTERVAL_MS, Math.floor(job.rule.intervalMs || 0));
  const startAtMs = Date.parse(job.rule.startAt);
  if (!Number.isFinite(startAtMs)) {
    return void 0;
  }
  if (job.lastFiredAt) {
    const lastFiredAtMs = Date.parse(job.lastFiredAt);
    if (!Number.isFinite(lastFiredAtMs)) {
      return void 0;
    }
    let nextMs2 = lastFiredAtMs + intervalMs;
    while (nextMs2 <= now.getTime()) {
      nextMs2 += intervalMs;
    }
    return new Date(nextMs2).toISOString();
  }
  if (job.rule.fireImmediately) {
    if (startAtMs > now.getTime()) {
      return new Date(startAtMs).toISOString();
    }
    return now.toISOString();
  }
  let nextMs = startAtMs + intervalMs;
  while (nextMs <= now.getTime()) {
    nextMs += intervalMs;
  }
  return new Date(nextMs).toISOString();
}
function normalizeScheduleExecutionPolicy(execution, existing) {
  const rawMaxRuns = execution?.maxRuns ?? existing?.execution?.maxRuns ?? DEFAULT_MAX_RUNS;
  const safeMaxRuns = Number.isFinite(rawMaxRuns) && typeof rawMaxRuns === "number" ? Math.max(0, Math.floor(rawMaxRuns)) : DEFAULT_MAX_RUNS;
  const rawFiredCount = execution?.firedCount ?? existing?.execution?.firedCount ?? 0;
  const safeFiredCount = Number.isFinite(rawFiredCount) && typeof rawFiredCount === "number" ? Math.max(0, Math.floor(rawFiredCount)) : 0;
  const endAt = typeof execution?.endAt === "string" && execution.endAt.trim() ? execution.endAt : typeof existing?.execution?.endAt === "string" && existing.execution.endAt.trim() ? existing.execution.endAt : void 0;
  return {
    maxRuns: safeMaxRuns,
    firedCount: safeFiredCount,
    ...endAt ? { endAt } : {}
  };
}
function hasReachedExecutionLimit(job) {
  const execution = normalizeScheduleExecutionPolicy(job.execution, job);
  return execution.maxRuns > 0 && execution.firedCount >= execution.maxRuns;
}
function computeNextFireAtForJob(job, now = /* @__PURE__ */ new Date()) {
  const execution = normalizeScheduleExecutionPolicy(job.execution, job);
  if (!job.enabled) {
    return void 0;
  }
  if (hasReachedExecutionLimit(job)) {
    return void 0;
  }
  if (execution.endAt) {
    const endAtMs = Date.parse(execution.endAt);
    if (!Number.isFinite(endAtMs) || endAtMs <= now.getTime()) {
      return void 0;
    }
  }
  const nextCandidate = job.rule.kind === "interval" ? resolveNextIntervalFireAt(job, now) : resolveNextAlarmFireAt(job.rule, now);
  if (!nextCandidate) {
    return void 0;
  }
  if (execution.endAt) {
    const endAtMs = Date.parse(execution.endAt);
    const nextCandidateMs = Date.parse(nextCandidate);
    if (!Number.isFinite(endAtMs) || !Number.isFinite(nextCandidateMs) || nextCandidateMs > endAtMs) {
      return void 0;
    }
  }
  return nextCandidate;
}
function normalizeScheduleDraft(draft, options) {
  const now = options?.now || /* @__PURE__ */ new Date();
  const existing = options?.existing || null;
  const targetSessionName = draft.targetSessionName.trim();
  const enabled = draft.enabled ?? existing?.enabled ?? true;
  const label = (draft.label || "").trim() || targetSessionName || "Scheduled message";
  const payload = {
    text: draft.payload.text,
    appendEnter: Boolean(draft.payload.appendEnter)
  };
  const baseJob = {
    id: draft.id || existing?.id || "",
    targetSessionName,
    label,
    enabled,
    payload,
    rule: draft.rule,
    execution: normalizeScheduleExecutionPolicy(draft.execution, existing),
    nextFireAt: existing?.nextFireAt,
    lastFiredAt: existing?.lastFiredAt,
    lastResult: existing?.lastResult,
    lastError: existing?.lastError,
    createdAt: existing?.createdAt || now.toISOString(),
    updatedAt: now.toISOString()
  };
  return {
    ...baseJob,
    nextFireAt: computeNextFireAtForJob(baseJob, now)
  };
}

// src/server/terminal-message-control-runtime.ts
function handleSessionOpenMessageRuntime(deps, connection, payload) {
  connection.role = "control";
  connection.boundSubscriberId = null;
  const sessionName = deps.sanitizeSessionName(payload.sessionName);
  const sessionTransportToken = deps.issueSessionTransportToken();
  console.log(
    `[server] session-open transport=${connection.transportId} openRequestId=${payload.openRequestId || "n/a"} session=${sessionName}`
  );
  deps.sendTransportMessage(connection.transport, {
    type: "session-ticket",
    payload: {
      openRequestId: payload.openRequestId,
      sessionTransportToken,
      sessionName
    }
  });
  return null;
}
function handleSessionTransportConnectRuntime(deps, connection, payload) {
  const token = (payload.sessionTransportToken || "").trim();
  if (!token || !deps.consumeSessionTransportToken(token)) {
    console.warn(
      `[server] transport-attach-invalid transport=${connection.transportId} openRequestId=${payload.openRequestId || "n/a"} session=${deps.sanitizeSessionName(payload.sessionName)} tokenPresent=${token ? "yes" : "no"}`
    );
    deps.sendTransportMessage(connection.transport, {
      type: "error",
      payload: {
        message: "Invalid transport attach token",
        code: "transport_attach_invalid"
      }
    });
    connection.closeTransport("transport attach invalid");
    return null;
  }
  console.log(
    `[server] transport-attach-ok transport=${connection.transportId} openRequestId=${payload.openRequestId || "n/a"} session=${deps.sanitizeSessionName(payload.sessionName)}`
  );
  const subscriber = deps.createTransportSubscriber(connection);
  return deps.bindConnectionToSubscriber(connection, subscriber);
}
function handleListSessionsMessageRuntime(deps, connection) {
  try {
    deps.sendTransportMessage(connection.transport, { type: "sessions", payload: { sessions: deps.listTmuxSessions() } });
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    deps.sendTransportMessage(connection.transport, {
      type: "error",
      payload: { message: `Failed to list tmux sessions: ${err}`, code: "list_sessions_failed" }
    });
  }
}
function handleScheduleMessageRuntime(deps, session, message, transport) {
  function sendScheduleError(targetSession, payload) {
    deps.sendMessage(targetSession, {
      type: "schedule-error",
      payload: {
        sessionName: deps.sanitizeSessionName(payload.sessionName || targetSession.sessionName),
        operation: payload.operation,
        jobId: payload.jobId,
        code: payload.code,
        message: payload.message
      }
    });
  }
  if (!session) {
    deps.sendTransportMessage(transport, {
      type: "error",
      payload: { message: `${message.type} requires an attached session transport`, code: "session_required" }
    });
    return;
  }
  switch (message.type) {
    case "schedule-list":
      deps.sendScheduleStateToSession(session, deps.sanitizeSessionName(message.payload.sessionName || session.sessionName));
      return;
    case "schedule-upsert":
      try {
        const normalized = normalizeScheduleDraft(
          {
            ...message.payload.job,
            targetSessionName: deps.sanitizeSessionName(message.payload.job.targetSessionName || session.sessionName)
          },
          {
            now: /* @__PURE__ */ new Date(),
            existing: message.payload.job.id ? deps.scheduleEngine.listBySession(
              deps.sanitizeSessionName(message.payload.job.targetSessionName || session.sessionName)
            ).find((job) => job.id === message.payload.job.id) || null : null
          }
        );
        if (!normalized.targetSessionName) {
          sendScheduleError(session, {
            operation: "upsert",
            code: "schedule_invalid_target",
            message: "Missing target session"
          });
          return;
        }
        deps.scheduleEngine.upsert({
          ...message.payload.job,
          targetSessionName: normalized.targetSessionName
        });
      } catch (error) {
        const err = error instanceof Error ? error.message : String(error);
        sendScheduleError(session, {
          operation: "upsert",
          jobId: message.payload.job.id,
          code: "schedule_upsert_failed",
          message: `Failed to save schedule: ${err}`,
          sessionName: message.payload.job.targetSessionName
        });
      }
      return;
    case "schedule-delete":
      if (!deps.scheduleEngine.delete(message.payload.jobId)) {
        sendScheduleError(session, {
          operation: "delete",
          jobId: message.payload.jobId,
          code: "schedule_job_not_found",
          message: "Schedule job no longer exists"
        });
      }
      return;
    case "schedule-toggle":
      if (!deps.scheduleEngine.toggle(message.payload.jobId, Boolean(message.payload.enabled))) {
        sendScheduleError(session, {
          operation: "toggle",
          jobId: message.payload.jobId,
          code: "schedule_job_not_found",
          message: "Schedule job no longer exists"
        });
      }
      return;
    case "schedule-run-now":
      void deps.scheduleEngine.runNow(message.payload.jobId).then((job) => {
        if (!job) {
          sendScheduleError(session, {
            operation: "run-now",
            jobId: message.payload.jobId,
            code: "schedule_job_not_found",
            message: "Schedule job no longer exists"
          });
        }
      }).catch((error) => {
        const err = error instanceof Error ? error.message : String(error);
        sendScheduleError(session, {
          operation: "run-now",
          jobId: message.payload.jobId,
          code: "schedule_run_now_failed",
          message: `Failed to run schedule: ${err}`
        });
      });
      return;
  }
}
function handleTmuxControlMessageRuntime(deps, connection, message) {
  switch (message.type) {
    case "tmux-create-session":
      try {
        deps.createDetachedTmuxSession(message.payload.sessionName, message.payload.cwd);
        deps.sendTransportMessage(connection.transport, { type: "sessions", payload: { sessions: deps.listTmuxSessions() } });
      } catch (error) {
        const err = error instanceof Error ? error.message : String(error);
        deps.sendTransportMessage(connection.transport, {
          type: "error",
          payload: { message: `Failed to create tmux session: ${err}`, code: "tmux_create_failed" }
        });
      }
      return;
    case "tmux-rename-session":
      try {
        const currentName = deps.sanitizeSessionName(message.payload.sessionName);
        const nextName = deps.renameTmuxSession(message.payload.sessionName, message.payload.nextSessionName);
        const currentKey = deps.getMirrorKey(currentName);
        const nextKey = deps.getMirrorKey(nextName);
        deps.scheduleEngine.renameSession(currentName, nextName);
        const mirror = deps.mirrors.get(currentKey);
        if (mirror && currentKey !== nextKey) {
          deps.mirrors.delete(currentKey);
          mirror.key = nextKey;
          mirror.sessionName = nextKey;
          deps.mirrors.set(nextKey, mirror);
          for (const sessionId of mirror.subscribers) {
            const subscriber = deps.sessions.get(sessionId);
            if (!subscriber) {
              continue;
            }
            subscriber.mirrorKey = nextKey;
            subscriber.sessionName = nextKey;
            deps.sendMessage(subscriber, { type: "title", payload: nextKey });
          }
        }
        deps.sendTransportMessage(connection.transport, { type: "sessions", payload: { sessions: deps.listTmuxSessions() } });
      } catch (error) {
        const err = error instanceof Error ? error.message : String(error);
        deps.sendTransportMessage(connection.transport, {
          type: "error",
          payload: { message: `Failed to rename tmux session: ${err}`, code: "tmux_rename_failed" }
        });
      }
      return;
    case "tmux-kill-session":
      try {
        const sessionName = deps.sanitizeSessionName(message.payload.sessionName);
        deps.closeDetachedTerminalSession(sessionName);
        deps.scheduleEngine.markSessionMissing(sessionName, "session killed");
        const mirror = deps.mirrors.get(deps.getMirrorKey(sessionName));
        if (mirror) {
          deps.destroyMirror(mirror, "tmux session killed", {
            closeTransportSubscribers: false,
            releaseCode: "tmux_session_killed"
          });
        }
        deps.sendTransportMessage(connection.transport, { type: "sessions", payload: { sessions: deps.listTmuxSessions() } });
      } catch (error) {
        const err = error instanceof Error ? error.message : String(error);
        deps.sendTransportMessage(connection.transport, {
          type: "error",
          payload: { message: `Failed to kill tmux session: ${err}`, code: "tmux_kill_failed" }
        });
      }
      return;
  }
}

// src/server/terminal-message-runtime.ts
var MAX_INPUT_PAYLOAD_BYTES = TERMINAL_INPUT_DAEMON_FRAME_MAX_BYTES;
function createTerminalMessageRuntime(deps) {
  function debugInput(scope, payload) {
    deps.daemonRuntimeDebug?.(`input-${scope}`, payload);
  }
  function resolveCurrentSessionForInput(connection) {
    if (!connection.boundSubscriberId) {
      return null;
    }
    const current = deps.sessions.get(connection.boundSubscriberId) || null;
    if (!current) {
      return null;
    }
    if (current.transportId !== connection.transportId || current.transport !== connection.transport) {
      return null;
    }
    return current;
  }
  const reliableInputAckedSeqs = /* @__PURE__ */ new Map();
  const RELIABLE_INPUT_ACKED_SEQ_MAX = 2048;
  function reliableInputKey(sessionId, seq) {
    return `${sessionId}\0${seq}`;
  }
  function rememberReliableInputAck(sessionId, seq, bytes) {
    reliableInputAckedSeqs.set(reliableInputKey(sessionId, seq), { accepted: true, bytes });
    while (reliableInputAckedSeqs.size > RELIABLE_INPUT_ACKED_SEQ_MAX) {
      const oldestKey = reliableInputAckedSeqs.keys().next().value;
      if (typeof oldestKey !== "string") {
        break;
      }
      reliableInputAckedSeqs.delete(oldestKey);
    }
  }
  function readReliableInputAck(sessionId, seq) {
    return reliableInputAckedSeqs.get(reliableInputKey(sessionId, seq)) || null;
  }
  function sendInputAck(connection, payload) {
    deps.sendTransportMessage(connection.transport, {
      type: "input-ack",
      payload
    });
  }
  function sendMuxFrame(connection, frame) {
    deps.sendTransportMessage(connection.transport, frame);
  }
  function resolveMuxChannelSubscriber(connection, channelId) {
    const subscriberId = connection.muxChannels?.get(channelId) || "";
    return subscriberId ? deps.sessions.get(subscriberId) || null : null;
  }
  function createMuxChannelMessageConnection(connection, subscriber) {
    return {
      ...connection,
      role: "session",
      boundSubscriberId: subscriber.id,
      transport: subscriber.transport || connection.transport,
      closeTransport: subscriber.closeTransport || (() => {
      }),
      muxVersion: void 0,
      muxClientInstanceId: null,
      muxChannels: void 0
    };
  }
  function createMuxTargetMessageConnection(connection, requestId) {
    return {
      ...connection,
      boundSubscriberId: null,
      transport: {
        kind: connection.transport.kind,
        requestOrigin: connection.requestOrigin,
        connectedSent: false,
        get readyState() {
          return connection.transport.readyState;
        },
        get bufferedAmount() {
          return Math.max(0, Math.floor(connection.transport.bufferedAmount || 0));
        },
        sendText(text) {
          let message;
          try {
            message = JSON.parse(text);
          } catch {
            sendMuxFrame(connection, buildTerminalMuxError(
              "mux_protocol_invalid",
              "mux target send requires a JSON server message"
            ));
            return;
          }
          sendMuxFrame(
            connection,
            buildTerminalMuxServerTargetMessage(
              message,
              requestId
            )
          );
        },
        close: connection.transport.close,
        ping: connection.transport.ping
      },
      muxVersion: void 0,
      muxClientInstanceId: null,
      muxChannels: void 0
    };
  }
  function rejectMuxProtocol(connection, message, channelId) {
    sendMuxFrame(connection, buildTerminalMuxError("mux_protocol_invalid", message, channelId));
  }
  async function handleMuxFrame(connection, candidate) {
    if (!isTerminalMuxClientFrame(candidate)) {
      rejectMuxProtocol(connection, "invalid terminal mux frame");
      return;
    }
    const frame = candidate;
    switch (frame.type) {
      case "mux-hello":
        connection.muxVersion = frame.payload.version;
        connection.muxClientInstanceId = frame.payload.clientInstanceId;
        if (!connection.muxChannels) {
          connection.muxChannels = /* @__PURE__ */ new Map();
        }
        sendMuxFrame(connection, buildTerminalMuxReady({
          capabilities: buildTerminalMuxCapabilities({
            reliableInput: { version: 1 }
          })
        }));
        return;
      case "mux-target-message": {
        await handleMessage(
          createMuxTargetMessageConnection(connection, frame.payload.requestId),
          Buffer.from(JSON.stringify(frame.payload.message))
        );
        return;
      }
      case "mux-channel-open": {
        if (!connection.muxVersion) {
          sendMuxFrame(connection, buildTerminalMuxError(
            "daemon_multiplex_upgrade_required",
            "mux-channel-open requires mux-hello / mux-ready first",
            frame.payload.channelId
          ));
          return;
        }
        if (!connection.muxChannels) {
          connection.muxChannels = /* @__PURE__ */ new Map();
        }
        if (connection.muxChannels.has(frame.payload.channelId)) {
          sendMuxFrame(connection, buildTerminalMuxError(
            "mux_duplicate_channel",
            `mux channel ${frame.payload.channelId} is already open`,
            frame.payload.channelId
          ));
          return;
        }
        const subscriber = deps.controlRuntimeDeps.createMuxChannelSubscriber(connection, frame.payload.channelId);
        subscriber.sessionName = deps.controlRuntimeDeps.sanitizeSessionName(frame.payload.sessionName);
        subscriber.bodySubscribed = frame.payload.bodySubscribed !== false;
        sendMuxFrame(connection, {
          type: "mux-channel-opened",
          payload: {
            channelId: frame.payload.channelId,
            sessionName: subscriber.sessionName,
            capabilities: {
              reliableInput: { version: 1 }
            }
          }
        });
        void deps.controlRuntimeDeps.attachTmux(subscriber, {
          sessionName: frame.payload.sessionName,
          cols: frame.payload.cols,
          rows: frame.payload.rows,
          widthMode: frame.payload.widthMode,
          autoCommand: frame.payload.autoCommand
        }).catch((error) => {
          sendMuxFrame(connection, {
            type: "mux-channel-message",
            payload: {
              channelId: frame.payload.channelId,
              message: {
                type: "error",
                payload: {
                  message: error instanceof Error ? error.message : "Invalid mux channel open payload",
                  code: "mux_channel_open_failed"
                }
              }
            }
          });
        });
        return;
      }
      case "mux-channel-message": {
        const envelope = validateTerminalMuxChannelEnvelope(frame, {
          hasChannel: (channelId) => Boolean(resolveMuxChannelSubscriber(connection, channelId))
        });
        if (!envelope.ok) {
          sendMuxFrame(connection, envelope.error);
          return;
        }
        const subscriber = resolveMuxChannelSubscriber(connection, envelope.channelId);
        if (!subscriber) {
          sendMuxFrame(connection, buildTerminalMuxError(
            "mux_unknown_channel",
            `mux channel ${envelope.channelId} is not open`,
            envelope.channelId
          ));
          return;
        }
        await handleMessage(
          createMuxChannelMessageConnection(connection, subscriber),
          Buffer.from(JSON.stringify(frame.payload.message))
        );
        return;
      }
      case "mux-channel-binary": {
        const envelope = validateTerminalMuxChannelEnvelope(frame, {
          hasChannel: (channelId) => Boolean(resolveMuxChannelSubscriber(connection, channelId))
        });
        if (!envelope.ok) {
          sendMuxFrame(connection, envelope.error);
          return;
        }
        const subscriber = resolveMuxChannelSubscriber(connection, envelope.channelId);
        if (!subscriber) {
          sendMuxFrame(connection, buildTerminalMuxError(
            "mux_unknown_channel",
            `mux channel ${envelope.channelId} is not open`,
            envelope.channelId
          ));
          return;
        }
        await handleMessage(
          createMuxChannelMessageConnection(connection, subscriber),
          Buffer.from(frame.payload.dataBase64, "base64"),
          true
        );
        return;
      }
      case "mux-channel-close": {
        const envelope = validateTerminalMuxChannelEnvelope(frame, {
          hasChannel: (channelId) => Boolean(resolveMuxChannelSubscriber(connection, channelId))
        });
        if (!envelope.ok) {
          sendMuxFrame(connection, envelope.error);
          return;
        }
        const subscriber = resolveMuxChannelSubscriber(connection, envelope.channelId);
        if (subscriber) {
          connection.muxChannels?.delete(envelope.channelId);
          deps.closeSession(subscriber, frame.payload.reason || "client requested channel close", false);
        }
        return;
      }
      case "mux-ping":
        sendMuxFrame(connection, {
          type: "mux-pong",
          payload: {
            sentAt: frame.payload.sentAt,
            receivedAt: Date.now()
          }
        });
        return;
    }
  }
  function normalizeReliableInputPayload(payload) {
    if (!payload || typeof payload !== "object") {
      return null;
    }
    const candidate = payload;
    if (candidate.version !== 1 || typeof candidate.seq !== "string" || candidate.seq.trim().length === 0 || typeof candidate.data !== "string" || typeof candidate.sentAt !== "number" || !Number.isFinite(candidate.sentAt) || typeof candidate.attempt !== "number" || !Number.isFinite(candidate.attempt)) {
      return null;
    }
    return {
      version: 1,
      seq: candidate.seq,
      data: candidate.data,
      sentAt: candidate.sentAt,
      attempt: Math.max(0, Math.floor(candidate.attempt))
    };
  }
  function readReliableInputSeq(payload) {
    if (!payload || typeof payload !== "object") {
      return "";
    }
    const seq = payload.seq;
    return typeof seq === "string" ? seq.trim() : "";
  }
  function reportInputDrop(connection, reason, bytes, ackSeq) {
    debugInput("drop", {
      transportId: connection.transportId,
      sessionId: connection.boundSubscriberId,
      reason,
      bytes,
      queueDepth: 0
    });
    if (ackSeq) {
      sendInputAck(connection, {
        version: 1,
        seq: ackSeq,
        accepted: false,
        bytes,
        error: reason
      });
    }
    deps.sendTransportMessage(connection.transport, {
      type: "error",
      payload: reason === "input_stale_transport" ? { message: "input requires the current attached session transport", code: "input_stale_transport" } : { message: "input requires an attached session transport", code: "session_required" }
    });
  }
  async function writeInputIfCurrent(connection, data, ackSeq) {
    const bytes = Buffer.byteLength(data, "utf8");
    if (bytes > MAX_INPUT_PAYLOAD_BYTES) {
      debugInput("drop", {
        transportId: connection.transportId,
        sessionId: connection.boundSubscriberId,
        reason: "input_too_large",
        bytes,
        queueDepth: 0,
        max: MAX_INPUT_PAYLOAD_BYTES
      });
      deps.sendTransportMessage(connection.transport, {
        type: "error",
        payload: {
          message: `input payload exceeds ${MAX_INPUT_PAYLOAD_BYTES} bytes; client must chunk`,
          code: "input_too_large"
        }
      });
      if (ackSeq) {
        sendInputAck(connection, {
          version: 1,
          seq: ackSeq,
          accepted: false,
          bytes,
          error: "input_too_large"
        });
      }
      return;
    }
    debugInput("receive", {
      transportId: connection.transportId,
      sessionId: connection.boundSubscriberId,
      bytes,
      queueDepth: 0
    });
    const inputSession = resolveCurrentSessionForInput(connection);
    if (!inputSession) {
      reportInputDrop(
        connection,
        connection.boundSubscriberId && deps.sessions.has(connection.boundSubscriberId) ? "input_stale_transport" : "session_required",
        bytes,
        ackSeq
      );
      return;
    }
    if (ackSeq) {
      const existingAck = readReliableInputAck(inputSession.id, ackSeq);
      if (existingAck) {
        sendInputAck(connection, {
          version: 1,
          seq: ackSeq,
          accepted: true,
          bytes: existingAck.bytes
        });
        debugInput("write", {
          transportId: connection.transportId,
          sessionId: inputSession.id,
          sessionName: inputSession.sessionName,
          bytes: existingAck.bytes,
          duplicateSeq: ackSeq,
          queueDepth: 0
        });
        return;
      }
    }
    const startedAt = Date.now();
    const wrote = await deps.handleInput(inputSession, data, () => {
      const current = resolveCurrentSessionForInput(connection);
      return current?.id === inputSession.id;
    });
    if (!wrote) {
      reportInputDrop(connection, "input_stale_transport", bytes, ackSeq);
      return;
    }
    if (ackSeq) {
      rememberReliableInputAck(inputSession.id, ackSeq, bytes);
      sendInputAck(connection, {
        version: 1,
        seq: ackSeq,
        accepted: true,
        bytes
      });
    }
    debugInput("write", {
      transportId: connection.transportId,
      sessionId: inputSession.id,
      sessionName: inputSession.sessionName,
      bytes,
      durationMs: Date.now() - startedAt,
      queueDepth: 0
    });
  }
  function sendSessionNotReadyError(session, operation) {
    deps.sendMessage(session, {
      type: "error",
      payload: {
        message: `${operation} requires a ready mirror`,
        code: "session_not_ready"
      }
    });
  }
  function handleSessionOpen(connection, payload) {
    return handleSessionOpenMessageRuntime(deps.controlRuntimeDeps, connection, payload);
  }
  function handleSessionTransportConnect(connection, payload) {
    return handleSessionTransportConnectRuntime(deps.controlRuntimeDeps, connection, payload);
  }
  async function handleMessage(connection, rawData, isBinary = false) {
    const session = connection.boundSubscriberId ? deps.sessions.get(connection.boundSubscriberId) || null : null;
    if (isBinary) {
      if (!session) {
        deps.sendTransportMessage(connection.transport, {
          type: "error",
          payload: { message: "Binary payload requires an attached session transport", code: "binary_requires_session" }
        });
        return;
      }
      const binaryBuffer = Buffer.isBuffer(rawData) ? rawData : Array.isArray(rawData) ? Buffer.concat(rawData) : Buffer.from(rawData);
      deps.terminalFileTransferRuntime.handleBinaryPayload(session, binaryBuffer);
      return;
    }
    const text = typeof rawData === "string" ? rawData : Buffer.isBuffer(rawData) ? rawData.toString("utf-8") : Array.isArray(rawData) ? Buffer.concat(rawData).toString("utf-8") : Buffer.from(rawData).toString("utf-8");
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      if (!connection.boundSubscriberId) {
        deps.sendTransportMessage(connection.transport, {
          type: "error",
          payload: { message: "Plain text input requires an attached session transport", code: "input_requires_session" }
        });
        return;
      }
      await writeInputIfCurrent(connection, text);
      return;
    }
    if (typeof message.type === "string" && message.type.startsWith("mux-")) {
      await handleMuxFrame(connection, message);
      return;
    }
    if (connection.muxVersion) {
      const messageType = message.type;
      if (typeof messageType === "string" && classifyTerminalMuxClientMessage(message) === "channel") {
        sendMuxFrame(connection, buildTerminalMuxUnwrappedSessionMessageError(messageType));
        return;
      }
      if (typeof messageType === "string" && classifyTerminalMuxClientMessage(message) === "legacy") {
        sendMuxFrame(connection, buildTerminalMuxError(
          "mux_unwrapped_session_message",
          `legacy message ${messageType} is not valid after mux-ready`
        ));
        return;
      }
    }
    switch (message.type) {
      case "session-open":
        try {
          handleSessionOpen(connection, message.payload);
        } catch (error) {
          deps.sendTransportMessage(connection.transport, {
            type: "session-open-failed",
            payload: {
              openRequestId: message.payload?.openRequestId || "",
              message: error instanceof Error ? error.message : "Invalid session-open payload",
              code: "session_open_invalid"
            }
          });
        }
        break;
      case "list-sessions":
        handleListSessionsMessageRuntime(deps.controlRuntimeDeps, connection);
        break;
      case "schedule-list":
        handleScheduleMessageRuntime(deps.controlRuntimeDeps, session, message, connection.transport);
        break;
      case "schedule-upsert":
        handleScheduleMessageRuntime(deps.controlRuntimeDeps, session, message, connection.transport);
        break;
      case "schedule-delete":
        handleScheduleMessageRuntime(deps.controlRuntimeDeps, session, message, connection.transport);
        break;
      case "schedule-toggle":
        handleScheduleMessageRuntime(deps.controlRuntimeDeps, session, message, connection.transport);
        break;
      case "schedule-run-now":
        handleScheduleMessageRuntime(deps.controlRuntimeDeps, session, message, connection.transport);
        break;
      case "connect":
        try {
          const serverSession = handleSessionTransportConnect(connection, message.payload);
          if (serverSession) {
            void deps.controlRuntimeDeps.attachTmux(serverSession, message.payload).catch((error) => {
              deps.sendTransportMessage(connection.transport, {
                type: "error",
                payload: {
                  message: error instanceof Error ? error.message : "Invalid connect payload",
                  code: "connect_payload_invalid"
                }
              });
            });
          }
        } catch (error) {
          deps.sendTransportMessage(connection.transport, {
            type: "error",
            payload: {
              message: error instanceof Error ? error.message : "Invalid connect payload",
              code: "connect_payload_invalid"
            }
          });
        }
        break;
      case "resize":
        if (!session) {
          deps.sendTransportMessage(connection.transport, {
            type: "error",
            payload: { message: "resize requires an attached session transport", code: "session_required" }
          });
          break;
        }
        try {
          const resizeResult = deps.controlRuntimeDeps.handleAdaptiveResize?.(session, {
            cols: typeof message.payload?.cols === "number" && Number.isFinite(message.payload.cols) ? message.payload.cols : void 0,
            widthMode: message.payload?.widthMode === "adaptive-phone" ? "adaptive-phone" : "mirror-fixed"
          });
          if (resizeResult && !resizeResult.ok) {
            deps.sendMessage(session, {
              type: "error",
              payload: {
                message: resizeResult.message,
                code: resizeResult.code
              }
            });
          }
        } catch (error) {
          deps.sendTransportMessage(connection.transport, {
            type: "error",
            payload: {
              message: error instanceof Error ? error.message : "Resize failed",
              code: "resize_failed"
            }
          });
        }
        break;
      case "body-subscription": {
        if (!session) {
          deps.sendTransportMessage(connection.transport, {
            type: "error",
            payload: { message: "body-subscription requires an attached session transport", code: "session_required" }
          });
          break;
        }
        if (message.payload?.version !== 1 || typeof message.payload.subscribed !== "boolean") {
          deps.sendMessage(session, {
            type: "error",
            payload: {
              message: "body-subscription requires version=1 and boolean subscribed",
              code: "body_subscription_invalid"
            }
          });
          break;
        }
        session.bodySubscribed = message.payload.subscribed;
        const mirror = deps.getSessionMirror(session);
        if (mirror?.lifecycle === "ready") {
          if (message.payload.subscribed) {
            deps.sendBufferHeadToSession(session, mirror);
          }
          deps.scheduleMirrorLiveSync(mirror, 0);
        }
        break;
      }
      case "buffer-head-request": {
        if (!session) {
          deps.sendTransportMessage(connection.transport, {
            type: "error",
            payload: { message: "buffer-head-request requires an attached session transport", code: "session_required" }
          });
          break;
        }
        const mirror = deps.getSessionMirror(session);
        if (!mirror || mirror.lifecycle !== "ready") {
          sendSessionNotReadyError(session, "buffer-head-request");
          break;
        }
        deps.sendBufferHeadToSession(session, mirror);
        break;
      }
      case "paste-image-start":
        if (!session) {
          deps.sendTransportMessage(connection.transport, {
            type: "error",
            payload: { message: "paste-image-start requires an attached session transport", code: "session_required" }
          });
          break;
        }
        session.pendingPasteImage = {
          payload: message.payload,
          receivedBytes: 0,
          chunks: []
        };
        break;
      case "attach-file-start":
        if (!session) {
          deps.sendTransportMessage(connection.transport, {
            type: "error",
            payload: { message: "attach-file-start requires an attached session transport", code: "session_required" }
          });
          break;
        }
        session.pendingAttachFile = {
          payload: message.payload,
          receivedBytes: 0,
          chunks: []
        };
        break;
      case "buffer-sync-request": {
        if (!session) {
          deps.sendTransportMessage(connection.transport, {
            type: "error",
            payload: { message: "buffer-sync-request requires an attached session transport", code: "session_required" }
          });
          break;
        }
        const mirror = deps.getSessionMirror(session);
        if (!mirror || mirror.lifecycle !== "ready") {
          sendSessionNotReadyError(session, "buffer-sync-request");
          break;
        }
        let request;
        try {
          request = deps.normalizeBufferSyncRequestPayload(session, message.payload);
        } catch (error) {
          deps.sendMessage(session, {
            type: "error",
            payload: {
              message: error instanceof Error ? error.message : "Invalid buffer-sync-request",
              code: "buffer_sync_request_invalid"
            }
          });
          break;
        }
        const payload = buildRequestedRangeBufferPayload(mirror, request);
        deps.sendMessage(session, { type: "buffer-sync", payload });
        break;
      }
      case "debug-log":
        if (!session) {
          deps.sendTransportMessage(connection.transport, {
            type: "error",
            payload: { message: "debug-log requires an attached session transport", code: "session_required" }
          });
          break;
        }
        deps.handleClientDebugLog(session, message.payload);
        break;
      case "debug-snapshot":
        if (!session) {
          deps.sendTransportMessage(connection.transport, {
            type: "error",
            payload: { message: "debug-snapshot requires an attached session transport", code: "session_required" }
          });
          break;
        }
        deps.handleClientDebugSnapshot(session, message.payload);
        break;
      case "tmux-create-session":
        handleTmuxControlMessageRuntime(deps.controlRuntimeDeps, connection, message);
        break;
      case "tmux-rename-session":
        handleTmuxControlMessageRuntime(deps.controlRuntimeDeps, connection, message);
        break;
      case "tmux-kill-session":
        handleTmuxControlMessageRuntime(deps.controlRuntimeDeps, connection, message);
        break;
      case "input":
        if (typeof message.payload === "string") {
          await writeInputIfCurrent(connection, message.payload);
          break;
        }
        {
          const reliablePayload = normalizeReliableInputPayload(message.payload);
          if (reliablePayload) {
            await writeInputIfCurrent(connection, reliablePayload.data, reliablePayload.seq);
            break;
          }
        }
        {
          const invalidSeq = readReliableInputSeq(message.payload);
          if (invalidSeq) {
            sendInputAck(connection, {
              version: 1,
              seq: invalidSeq,
              accepted: false,
              bytes: 0,
              error: "input_invalid"
            });
          }
        }
        if (!session) {
          deps.sendTransportMessage(connection.transport, {
            type: "error",
            payload: { message: "input requires an attached session transport", code: "session_required" }
          });
          break;
        }
        deps.sendMessage(session, {
          type: "error",
          payload: { message: "invalid input payload", code: "input_invalid" }
        });
        break;
      case "paste-image":
        if (!session) {
          deps.sendTransportMessage(connection.transport, {
            type: "error",
            payload: { message: "paste-image requires an attached session transport", code: "session_required" }
          });
          break;
        }
        deps.terminalFileTransferRuntime.handlePasteImage(session, message.payload);
        break;
      case "ping":
        deps.sendTransportMessage(connection.transport, { type: "pong" });
        break;
      case "close":
        if (!session) {
          connection.closeTransport("client requested close");
          break;
        }
        deps.closeSession(session, "client requested close", false);
        break;
      case "file-list-request":
        if (!session) {
          deps.sendTransportMessage(connection.transport, {
            type: "error",
            payload: { message: "file-list-request requires an attached session transport", code: "session_required" }
          });
          break;
        }
        deps.terminalFileTransferRuntime.handleFileListRequest(session, message.payload);
        break;
      case "file-create-directory-request":
        if (!session) {
          deps.sendTransportMessage(connection.transport, {
            type: "error",
            payload: { message: "file-create-directory-request requires an attached session transport", code: "session_required" }
          });
          break;
        }
        deps.terminalFileTransferRuntime.handleFileCreateDirectoryRequest(session, message.payload);
        break;
      case "file-download-request":
        if (!session) {
          deps.sendTransportMessage(connection.transport, {
            type: "error",
            payload: { message: "file-download-request requires an attached session transport", code: "session_required" }
          });
          break;
        }
        deps.terminalFileTransferRuntime.handleFileDownloadRequest(session, message.payload);
        break;
      case "remote-screenshot-request":
        if (!session) {
          deps.sendTransportMessage(connection.transport, {
            type: "error",
            payload: { message: "remote-screenshot-request requires an attached session transport", code: "session_required" }
          });
          break;
        }
        void deps.terminalFileTransferRuntime.handleRemoteScreenshotRequest(session, message.payload);
        break;
      case "remote-window-targets-request":
        void deps.remoteWindowStreamRuntime.listTargets(message.payload).then((payload) => {
          deps.sendTransportMessage(connection.transport, "targets" in payload ? { type: "remote-window-targets-response", payload } : { type: "remote-window-error", payload });
        }).catch((error) => {
          deps.sendTransportMessage(connection.transport, {
            type: "remote-window-error",
            payload: {
              requestId: message.payload.requestId || "",
              code: "remote_window_catalog_failed",
              message: error instanceof Error ? error.message : "remote window catalog failed"
            }
          });
        });
        break;
      case "remote-window-stream-start-request":
        void deps.remoteWindowStreamRuntime.startStream(message.payload, {
          sendIceCandidate: (payload) => {
            deps.sendTransportMessage(connection.transport, {
              type: "remote-window-stream-ice-candidate",
              payload
            });
          },
          sendStatus: (payload) => {
            deps.sendTransportMessage(connection.transport, {
              type: "remote-window-stream-status",
              payload
            });
          }
        }).then((payload) => {
          deps.sendTransportMessage(connection.transport, "answer" in payload ? { type: "remote-window-stream-started", payload } : { type: "remote-window-error", payload });
        }).catch((error) => {
          deps.sendTransportMessage(connection.transport, {
            type: "remote-window-error",
            payload: {
              requestId: message.payload.requestId || "",
              streamId: message.payload.streamId || "",
              code: "remote_window_stream_start_failed",
              message: error instanceof Error ? error.message : "remote window stream start failed"
            }
          });
        });
        break;
      case "remote-window-stream-ice-candidate":
        void deps.remoteWindowStreamRuntime.addIceCandidate(message.payload).catch((error) => {
          deps.sendTransportMessage(connection.transport, {
            type: "remote-window-error",
            payload: {
              requestId: message.payload.requestId || "",
              streamId: message.payload.streamId || "",
              code: "remote_window_stream_candidate_failed",
              message: error instanceof Error ? error.message : "remote window stream ICE candidate failed"
            }
          });
        });
        break;
      case "remote-window-stream-stop-request":
        void deps.remoteWindowStreamRuntime.stopStream(message.payload).then((payload) => {
          deps.sendTransportMessage(connection.transport, "phase" in payload ? { type: "remote-window-stream-status", payload } : { type: "remote-window-error", payload });
        }).catch((error) => {
          deps.sendTransportMessage(connection.transport, {
            type: "remote-window-error",
            payload: {
              requestId: message.payload.requestId || "",
              streamId: message.payload.streamId || "",
              code: "remote_window_stream_stop_failed",
              message: error instanceof Error ? error.message : "remote window stream stop failed"
            }
          });
        });
        break;
      case "remote-window-stream-quality-request":
        void deps.remoteWindowStreamRuntime.updateStreamQuality(message.payload).then((payload) => {
          deps.sendTransportMessage(connection.transport, "accepted" in payload ? { type: "remote-window-stream-quality-result", payload } : { type: "remote-window-error", payload });
        }).catch((error) => {
          deps.sendTransportMessage(connection.transport, {
            type: "remote-window-error",
            payload: {
              requestId: message.payload.requestId || "",
              streamId: message.payload.streamId || "",
              code: "remote_window_stream_quality_failed",
              message: error instanceof Error ? error.message : "remote window stream quality update failed"
            }
          });
        });
        break;
      case "remote-window-input":
        void deps.remoteWindowStreamRuntime.injectInput(message.payload).then((payload) => {
          deps.sendTransportMessage(connection.transport, "accepted" in payload ? { type: "remote-window-input-result", payload } : { type: "remote-window-error", payload });
        }).catch((error) => {
          deps.sendTransportMessage(connection.transport, {
            type: "remote-window-error",
            payload: {
              requestId: message.payload.requestId || "",
              streamId: message.payload.streamId || "",
              code: "remote_window_input_failed",
              message: error instanceof Error ? error.message : "remote window input failed"
            }
          });
        });
        break;
      case "file-upload-start":
        if (!session) {
          deps.sendTransportMessage(connection.transport, {
            type: "error",
            payload: { message: "file-upload-start requires an attached session transport", code: "session_required" }
          });
          break;
        }
        deps.terminalFileTransferRuntime.handleFileUploadStart(session, message.payload);
        break;
      case "file-upload-chunk":
        if (!session) {
          deps.sendTransportMessage(connection.transport, {
            type: "error",
            payload: { message: "file-upload-chunk requires an attached session transport", code: "session_required" }
          });
          break;
        }
        deps.terminalFileTransferRuntime.handleFileUploadChunk(session, message.payload);
        break;
      case "file-upload-end":
        if (!session) {
          deps.sendTransportMessage(connection.transport, {
            type: "error",
            payload: { message: "file-upload-end requires an attached session transport", code: "session_required" }
          });
          break;
        }
        deps.terminalFileTransferRuntime.handleFileUploadEnd(session, message.payload);
        break;
    }
  }
  return {
    handleSessionOpen,
    handleSessionTransportConnect,
    handleMessage
  };
}

// src/server/terminal-http-runtime.ts
var import_fs5 = require("fs");
var import_path5 = require("path");

// src/lib/terminal-performance-trace.ts
var FORBIDDEN_PAYLOAD_KEYS = /* @__PURE__ */ new Set(["payload", "text", "lines", "cells", "content", "data"]);
var TRACE_DEBUG_SCOPE = "terminal.performance.trace";
function assertMetadataOnly(record) {
  for (const key of FORBIDDEN_PAYLOAD_KEYS) {
    if (key in record) {
      throw new Error("terminal performance trace must not store payload content");
    }
  }
}
function createTerminalPerformanceTraceStore(options) {
  const limit = Math.max(1, Math.floor(options?.limit || 500));
  const records = [];
  return {
    record(record) {
      assertMetadataOnly(record);
      records.push({
        sessionId: record.sessionId,
        traceId: record.traceId,
        mirrorRevision: Number.isFinite(record.mirrorRevision) ? Math.max(0, Math.floor(record.mirrorRevision || 0)) : void 0,
        subscriberId: record.subscriberId,
        stage: record.stage,
        at: Math.max(0, Math.floor(record.at || 0)),
        bytes: Number.isFinite(record.bytes) ? Math.max(0, Math.floor(record.bytes || 0)) : void 0,
        lineCount: Number.isFinite(record.lineCount) ? Math.max(0, Math.floor(record.lineCount || 0)) : void 0,
        transportKind: record.transportKind
      });
      while (records.length > limit) {
        records.shift();
      }
    },
    snapshot() {
      return records.map((record) => ({ ...record }));
    },
    clear() {
      records.splice(0, records.length);
    }
  };
}
function normalizeTraceStage(input) {
  if (typeof input !== "string") {
    return null;
  }
  switch (input) {
    case "capture-start":
    case "capture-done":
    case "canonicalize-done":
    case "mirror-commit":
    case "send-start":
    case "send-done":
    case "client-rx":
    case "buffer-apply-done":
    case "render-raf":
    case "render-commit":
      return input;
    default:
      return null;
  }
}
function numberOrUndefined(input) {
  return typeof input === "number" && Number.isFinite(input) ? Math.max(0, Math.floor(input)) : void 0;
}
function parseRuntimeDebugPerformanceTraceRecords(entries) {
  const records = [];
  for (const entry of entries) {
    if (entry.scope !== TRACE_DEBUG_SCOPE || !entry.payload) {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(entry.payload);
    } catch {
      continue;
    }
    const stage = normalizeTraceStage(parsed.stage);
    if (!stage) {
      continue;
    }
    const safeRecord = {
      sessionId: typeof parsed.sessionId === "string" && parsed.sessionId.trim() ? parsed.sessionId.trim() : entry.sessionId,
      traceId: typeof parsed.traceId === "string" && parsed.traceId.trim() ? parsed.traceId.trim() : void 0,
      mirrorRevision: numberOrUndefined(parsed.mirrorRevision),
      subscriberId: typeof parsed.subscriberId === "string" && parsed.subscriberId.trim() ? parsed.subscriberId.trim() : void 0,
      stage,
      at: numberOrUndefined(parsed.at) ?? Date.now(),
      bytes: numberOrUndefined(parsed.bytes),
      lineCount: numberOrUndefined(parsed.lineCount),
      transportKind: typeof parsed.transportKind === "string" && parsed.transportKind.trim() ? parsed.transportKind.trim() : void 0
    };
    records.push(safeRecord);
  }
  return records;
}
function percentile95(values) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[index] ?? null;
}
function summarizeTerminalPerformanceTrace(records) {
  const bySample = /* @__PURE__ */ new Map();
  for (const record of records) {
    const sampleKey = [
      record.sessionId,
      record.traceId || "__legacy_trace__",
      Number.isFinite(record.mirrorRevision) ? String(record.mirrorRevision) : "__legacy_revision__",
      record.subscriberId || "__legacy_subscriber__"
    ].join("\0");
    const current = bySample.get(sampleKey) || [];
    current.push(record);
    bySample.set(sampleKey, current);
  }
  const sessions2 = Array.from(bySample.values()).map((sessionRecords) => {
    const first = sessionRecords[0];
    const byStage = /* @__PURE__ */ new Map();
    for (const record of sessionRecords) {
      byStage.set(record.stage, record);
    }
    const captureStart = byStage.get("capture-start")?.at;
    const sendDone = byStage.get("send-done")?.at;
    const clientRx = byStage.get("client-rx")?.at;
    const renderCommit = byStage.get("render-commit")?.at;
    return {
      sessionId: first?.sessionId || "",
      traceId: first?.traceId || null,
      mirrorRevision: Number.isFinite(first?.mirrorRevision) ? Math.max(0, Math.floor(first?.mirrorRevision || 0)) : null,
      subscriberId: first?.subscriberId || null,
      captureToRenderMs: Number.isFinite(captureStart) && Number.isFinite(renderCommit) ? Math.max(0, (renderCommit || 0) - (captureStart || 0)) : null,
      sendToRxMs: Number.isFinite(sendDone) && Number.isFinite(clientRx) ? Math.max(0, (clientRx || 0) - (sendDone || 0)) : null,
      rxToRenderMs: Number.isFinite(clientRx) && Number.isFinite(renderCommit) ? Math.max(0, (renderCommit || 0) - (clientRx || 0)) : null,
      bytes: sessionRecords.reduce((sum, record) => sum + Math.max(0, record.bytes || 0), 0),
      lineCount: sessionRecords.reduce((max, record) => Math.max(max, record.lineCount || 0), 0)
    };
  });
  return {
    sessions: sessions2,
    p95CaptureToRenderMs: percentile95(
      sessions2.map((session) => session.captureToRenderMs).filter((value) => Number.isFinite(value))
    ),
    p95SendToRxMs: percentile95(
      sessions2.map((session) => session.sendToRxMs).filter((value) => Number.isFinite(value))
    ),
    p95RxToRenderMs: percentile95(
      sessions2.map((session) => session.rxToRenderMs).filter((value) => Number.isFinite(value))
    )
  };
}

// src/server/terminal-http-runtime.ts
function createTerminalHttpRuntime(deps) {
  function readLatestUpdateManifest() {
    const manifestPath = (0, import_path5.join)(deps.updatesDir, "latest.json");
    if (!(0, import_fs5.existsSync)(manifestPath)) {
      return null;
    }
    try {
      return JSON.parse((0, import_fs5.readFileSync)(manifestPath, "utf-8"));
    } catch (error) {
      console.warn(`[${deps.logTimePrefix()}] failed to parse update manifest: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }
  function resolveRequestOrigin(request) {
    const host = request.headers.host || `${deps.host}:${deps.port}`;
    const protocol = "encrypted" in request.socket && request.socket.encrypted ? "https" : "http";
    return `${protocol}://${host}`;
  }
  function buildConnectedPayload(sessionId, requestOrigin) {
    const latestManifest = readLatestUpdateManifest();
    const manifestUrl = `${requestOrigin || `http://${deps.host}:${deps.port}`}/updates/latest.json`;
    return {
      sessionId,
      daemonHostId: deps.daemonHostId?.trim() || void 0,
      capabilities: {
        reliableInput: { version: 1 }
      },
      appUpdate: latestManifest && Number.isFinite(latestManifest.versionCode) && latestManifest.versionCode > 0 && latestManifest.versionName ? {
        versionCode: latestManifest.versionCode,
        versionName: latestManifest.versionName,
        manifestUrl
      } : Number.isFinite(deps.appUpdateVersionCode) && deps.appUpdateVersionCode > 0 && deps.appUpdateVersionName ? {
        versionCode: deps.appUpdateVersionCode,
        versionName: deps.appUpdateVersionName,
        manifestUrl: deps.appUpdateManifestUrl || manifestUrl
      } : void 0
    };
  }
  function writeCorsHeaders(response) {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-ZTerm-Token");
  }
  function serveJson(response, payload, statusCode = 200) {
    writeCorsHeaders(response);
    response.statusCode = statusCode;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(`${JSON.stringify(payload, null, 2)}
`);
  }
  function resolveUpdateFilePath(pathname) {
    const relativePath = pathname.replace(/^\/updates\//, "");
    const safeName = (0, import_path5.basename)(relativePath);
    const absolutePath = (0, import_path5.resolve)(deps.updatesDir, safeName);
    if (!absolutePath.startsWith((0, import_path5.resolve)(deps.updatesDir))) {
      return null;
    }
    return absolutePath;
  }
  function getMirrorAvailableEndIndex3(mirror) {
    return mirror.bufferStartIndex + mirror.bufferLines.length;
  }
  function buildRuntimeHealthSnapshot(request) {
    const requestHost = request.headers.host || `${deps.host}:${deps.port}`;
    const memoryUsage = process.memoryUsage();
    const subscriberEntries = Array.from(deps.sessions.values());
    const mirrorEntries = Array.from(deps.mirrors.values());
    return {
      ok: true,
      wsUrl: `ws://${requestHost}`,
      updatesUrl: `${resolveRequestOrigin(request)}/updates/latest.json`,
      updatesDir: deps.updatesDir,
      uptimeSec: Math.floor(process.uptime()),
      pid: process.pid,
      memory: {
        rss: memoryUsage.rss,
        heapTotal: memoryUsage.heapTotal,
        heapUsed: memoryUsage.heapUsed,
        external: memoryUsage.external,
        arrayBuffers: memoryUsage.arrayBuffers
      },
      sessions: {
        total: subscriberEntries.length,
        attached: subscriberEntries.filter((subscriber) => Boolean(subscriber.transport)).length,
        ready: subscriberEntries.filter((subscriber) => Boolean(subscriber.connectedSent || subscriber.transport?.connectedSent)).length
      },
      mirrors: {
        total: mirrorEntries.length,
        ready: mirrorEntries.filter((mirror) => mirror.lifecycle === "ready").length,
        subscribers: mirrorEntries.reduce((sum, mirror) => sum + mirror.subscribers.size, 0)
      }
    };
  }
  function extractHttpDebugToken(request, url) {
    const authorization = request.headers.authorization?.trim() || "";
    if (authorization.toLowerCase().startsWith("bearer ")) {
      return authorization.slice(7).trim();
    }
    const headerToken = request.headers["x-zterm-token"];
    if (typeof headerToken === "string" && headerToken.trim()) {
      return headerToken.trim();
    }
    return url.searchParams.get("token")?.trim() || "";
  }
  function ensureDebugAuthorized(request, response, url) {
    if (!deps.requiredAuthToken) {
      return true;
    }
    const providedToken = extractHttpDebugToken(request, url);
    if (providedToken === deps.requiredAuthToken) {
      return true;
    }
    serveJson(response, { message: "unauthorized debug access" }, 401);
    return false;
  }
  function buildDebugRuntimeSnapshot(request) {
    const subscriberEntries = Array.from(deps.sessions.values());
    const mirrorEntries = Array.from(deps.mirrors.values());
    const traceLimit = 1e3;
    const daemonTraceRecords = deps.performanceTraceStore.snapshot();
    const clientTraceRecords = parseRuntimeDebugPerformanceTraceRecords(
      deps.clientRuntimeDebugStore.listEntries({
        limit: traceLimit,
        scopeIncludes: "terminal.performance.trace"
      })
    );
    const daemonDebugTraceRecords = parseRuntimeDebugPerformanceTraceRecords(
      deps.daemonRuntimeDebugStore.listEntries({
        limit: traceLimit,
        scopeIncludes: "terminal.performance.trace"
      })
    );
    const performanceTraceRecords = [
      ...daemonTraceRecords,
      ...clientTraceRecords,
      ...daemonDebugTraceRecords
    ];
    return {
      ok: true,
      generatedAt: deps.logTimePrefix(),
      authEnabled: Boolean(deps.requiredAuthToken),
      health: buildRuntimeHealthSnapshot(request),
      clientDebug: deps.clientRuntimeDebugStore.getSummary(),
      daemonDebug: deps.daemonRuntimeDebugStore.getSummary(),
      performanceTrace: {
        recordCount: performanceTraceRecords.length,
        summary: summarizeTerminalPerformanceTrace(performanceTraceRecords)
      },
      clientDebugSnapshots: deps.clientRuntimeDebugStore.listSnapshots(),
      transportSubscribers: subscriberEntries.map((subscriber) => ({
        id: subscriber.id,
        sessionName: subscriber.sessionName,
        mirrorKey: subscriber.mirrorKey,
        transportId: subscriber.transportId,
        connectedSent: Boolean(subscriber.connectedSent || subscriber.transport?.connectedSent),
        muxChannelId: subscriber.muxChannelId || null,
        requestOrigin: subscriber.transport?.requestOrigin || null
      })),
      mirrors: mirrorEntries.map((mirror) => ({
        key: mirror.key,
        sessionName: mirror.sessionName,
        lifecycle: mirror.lifecycle,
        revision: mirror.revision,
        latestEndIndex: getMirrorAvailableEndIndex3(mirror),
        cols: mirror.cols,
        rows: mirror.rows,
        bufferStartIndex: mirror.bufferStartIndex,
        bufferEndIndex: getMirrorAvailableEndIndex3(mirror),
        bufferedLines: mirror.bufferLines.length,
        cursorKeysApp: mirror.cursorKeysApp,
        subscribers: Array.from(mirror.subscribers),
        lastFlushStartedAt: mirror.lastFlushStartedAt,
        lastFlushCompletedAt: mirror.lastFlushCompletedAt,
        flushInFlight: mirror.flushInFlight
      }))
    };
  }
  function handleHttpRequest(request, response) {
    writeCorsHeaders(response);
    if (request.method === "OPTIONS") {
      response.statusCode = 204;
      response.end();
      return;
    }
    const origin = resolveRequestOrigin(request);
    const url = new URL(request.url || "/", origin);
    if (url.pathname === "/health") {
      serveJson(response, buildRuntimeHealthSnapshot(request));
      return;
    }
    if (url.pathname === "/debug/runtime") {
      if (!ensureDebugAuthorized(request, response, url)) {
        return;
      }
      serveJson(response, buildDebugRuntimeSnapshot(request));
      return;
    }
    if (url.pathname === "/debug/runtime/logs") {
      if (!ensureDebugAuthorized(request, response, url)) {
        return;
      }
      const limit = deps.resolveDebugRouteLimit(url.searchParams.get("limit"));
      const sessionId = url.searchParams.get("sessionId")?.trim() || "";
      const tmuxSessionName = url.searchParams.get("tmuxSessionName")?.trim() || "";
      const scopeIncludes = url.searchParams.get("scope")?.trim() || "";
      const entries = deps.clientRuntimeDebugStore.listEntries({
        limit,
        sessionId: sessionId || void 0,
        tmuxSessionName: tmuxSessionName || void 0,
        scopeIncludes: scopeIncludes || void 0
      });
      const daemonEntries = deps.daemonRuntimeDebugStore.listEntries({
        limit,
        sessionId: sessionId || void 0,
        tmuxSessionName: tmuxSessionName || void 0,
        scopeIncludes: scopeIncludes || void 0
      });
      serveJson(response, {
        ok: true,
        generatedAt: deps.logTimePrefix(),
        limit,
        returned: entries.length,
        daemonReturned: daemonEntries.length,
        filters: {
          sessionId: sessionId || null,
          tmuxSessionName: tmuxSessionName || null,
          scope: scopeIncludes || null
        },
        entries,
        daemonEntries
      });
      return;
    }
    if (url.pathname === "/debug/runtime/control") {
      if (!ensureDebugAuthorized(request, response, url)) {
        return;
      }
      const enabledRaw = (url.searchParams.get("enabled") || "").trim().toLowerCase();
      const enabled = enabledRaw === "1" || enabledRaw === "true" || enabledRaw === "on";
      const sessionId = url.searchParams.get("sessionId")?.trim() || "";
      const reason = url.searchParams.get("reason")?.trim() || "remote-http-control";
      deps.setDaemonRuntimeDebugEnabled(enabled);
      deps.broadcastRuntimeDebugControl(enabled, reason, sessionId || void 0);
      serveJson(response, {
        ok: true,
        enabled,
        daemonDebugEnabled: enabled,
        reason,
        sessionId: sessionId || null,
        targetedSessions: sessionId ? Array.from(deps.sessions.values()).filter((session) => session.id === sessionId).map((session) => session.id) : Array.from(deps.sessions.values()).map((session) => session.id)
      });
      return;
    }
    if (url.pathname === "/updates/latest.json") {
      const manifestPath = (0, import_path5.join)(deps.updatesDir, "latest.json");
      if (!(0, import_fs5.existsSync)(manifestPath)) {
        serveJson(response, { message: "update manifest not found" }, 404);
        return;
      }
      try {
        const manifest = JSON.parse((0, import_fs5.readFileSync)(manifestPath, "utf-8"));
        serveJson(response, manifest);
      } catch (error) {
        serveJson(response, { message: `invalid update manifest: ${error instanceof Error ? error.message : String(error)}` }, 500);
      }
      return;
    }
    if (url.pathname.startsWith("/updates/")) {
      const filePath = resolveUpdateFilePath(url.pathname);
      if (!filePath || !(0, import_fs5.existsSync)(filePath)) {
        serveJson(response, { message: "update file not found" }, 404);
        return;
      }
      response.statusCode = 200;
      response.setHeader("Content-Type", filePath.endsWith(".apk") ? "application/vnd.android.package-archive" : "application/octet-stream");
      (0, import_fs5.createReadStream)(filePath).pipe(response);
      return;
    }
    serveJson(response, { message: "not found" }, 404);
  }
  return {
    resolveRequestOrigin,
    buildConnectedPayload,
    handleHttpRequest
  };
}

// src/server/schedule-engine.ts
var ScheduleEngine = class {
  jobs = /* @__PURE__ */ new Map();
  timer = null;
  running = false;
  disposed = false;
  saveJobs;
  executeJob;
  onStateChange;
  onEvent;
  now;
  constructor(options) {
    this.saveJobs = options.saveJobs;
    this.executeJob = options.executeJob;
    this.onStateChange = options.onStateChange;
    this.onEvent = options.onEvent;
    this.now = options.now || (() => /* @__PURE__ */ new Date());
    const now = this.now();
    for (const job of options.initialJobs || []) {
      const normalized = {
        ...job,
        execution: normalizeScheduleExecutionPolicy(job.execution),
        nextFireAt: computeNextFireAtForJob(job, now)
      };
      this.jobs.set(normalized.id, normalized);
    }
    this.persistAndReschedule();
  }
  dispose() {
    this.disposed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
  listBySession(sessionName) {
    return Array.from(this.jobs.values()).filter((job) => job.targetSessionName === sessionName).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }
  upsert(draft) {
    const now = this.now();
    const existing = draft.id ? this.jobs.get(draft.id) || null : null;
    const normalized = normalizeScheduleDraft(draft, { now, existing });
    const nextJob = {
      ...normalized,
      id: normalized.id || existing?.id || v4_default()
    };
    this.jobs.set(nextJob.id, nextJob);
    this.persistAndReschedule();
    this.emitState(nextJob.targetSessionName);
    this.emitEvent({
      sessionName: nextJob.targetSessionName,
      jobId: nextJob.id,
      type: "updated",
      at: now.toISOString(),
      message: "schedule updated"
    });
    return nextJob;
  }
  delete(jobId) {
    const existing = this.jobs.get(jobId);
    if (!existing) {
      return null;
    }
    this.jobs.delete(jobId);
    this.persistAndReschedule();
    this.emitState(existing.targetSessionName);
    this.emitEvent({
      sessionName: existing.targetSessionName,
      jobId,
      type: "deleted",
      at: this.now().toISOString(),
      message: "schedule deleted"
    });
    return existing;
  }
  toggle(jobId, enabled) {
    const existing = this.jobs.get(jobId);
    if (!existing) {
      return null;
    }
    const now = this.now();
    const nextJob = {
      ...existing,
      enabled,
      updatedAt: now.toISOString(),
      nextFireAt: enabled ? computeNextFireAtForJob({ ...existing, enabled }, now) : void 0
    };
    this.jobs.set(jobId, nextJob);
    this.persistAndReschedule();
    this.emitState(nextJob.targetSessionName);
    this.emitEvent({
      sessionName: nextJob.targetSessionName,
      jobId,
      type: "updated",
      at: now.toISOString(),
      message: enabled ? "schedule enabled" : "schedule disabled"
    });
    return nextJob;
  }
  async runNow(jobId) {
    const existing = this.jobs.get(jobId);
    if (!existing) {
      return null;
    }
    const executed = await this.execute(existing, this.now());
    this.persistAndReschedule();
    return executed;
  }
  renameSession(previousSessionName, nextSessionName) {
    if (!previousSessionName || previousSessionName === nextSessionName) {
      return;
    }
    const now = this.now().toISOString();
    let touched = false;
    for (const [jobId, job] of this.jobs.entries()) {
      if (job.targetSessionName !== previousSessionName) {
        continue;
      }
      touched = true;
      this.jobs.set(jobId, {
        ...job,
        targetSessionName: nextSessionName,
        label: job.label === previousSessionName ? nextSessionName : job.label,
        updatedAt: now
      });
    }
    if (!touched) {
      return;
    }
    this.persistAndReschedule();
    this.emitState(previousSessionName);
    this.emitState(nextSessionName);
  }
  markSessionMissing(sessionName, message = "session not found") {
    const now = this.now().toISOString();
    let touched = false;
    for (const [jobId, job] of this.jobs.entries()) {
      if (job.targetSessionName !== sessionName) {
        continue;
      }
      touched = true;
      this.jobs.set(jobId, {
        ...job,
        enabled: false,
        nextFireAt: void 0,
        lastResult: "error",
        lastError: message,
        updatedAt: now
      });
      this.emitEvent({
        sessionName,
        jobId,
        type: "error",
        at: now,
        message
      });
    }
    if (!touched) {
      return;
    }
    this.persistAndReschedule();
    this.emitState(sessionName);
  }
  emitState(sessionName) {
    this.onStateChange?.(sessionName, this.listBySession(sessionName));
  }
  emitEvent(event) {
    this.onEvent?.(event);
  }
  getNextDueJob() {
    return Array.from(this.jobs.values()).filter((job) => job.enabled && job.nextFireAt).sort((left, right) => {
      const leftMs = Date.parse(left.nextFireAt || "");
      const rightMs = Date.parse(right.nextFireAt || "");
      return leftMs - rightMs;
    }).find((job) => Number.isFinite(Date.parse(job.nextFireAt || ""))) || null;
  }
  persistAndReschedule() {
    const snapshot = Array.from(this.jobs.values()).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    this.saveJobs(snapshot);
    this.scheduleNextTimer();
  }
  scheduleNextTimer() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.disposed) {
      return;
    }
    const nextJob = this.getNextDueJob();
    if (!nextJob?.nextFireAt) {
      return;
    }
    const delay = Math.max(0, Date.parse(nextJob.nextFireAt) - this.now().getTime());
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runDueJobs();
    }, delay);
    this.timer.unref?.();
  }
  async runDueJobs() {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const now = this.now();
      const dueJobs = Array.from(this.jobs.values()).filter((job) => job.enabled && job.nextFireAt && Date.parse(job.nextFireAt) <= now.getTime()).sort((left, right) => Date.parse(left.nextFireAt || "") - Date.parse(right.nextFireAt || ""));
      for (const job of dueJobs) {
        await this.execute(job, this.now());
      }
    } finally {
      this.running = false;
      this.persistAndReschedule();
    }
  }
  async execute(job, now) {
    const currentBeforeExecute = this.jobs.get(job.id);
    if (!currentBeforeExecute) {
      return null;
    }
    const currentMaxRuns = Math.max(0, Math.floor(currentBeforeExecute.execution.maxRuns || 0));
    const currentFiredCount = Math.max(0, Math.floor(currentBeforeExecute.execution.firedCount || 0));
    if (currentMaxRuns > 0 && currentFiredCount >= currentMaxRuns) {
      const stoppedJob = {
        ...currentBeforeExecute,
        enabled: false,
        updatedAt: now.toISOString(),
        nextFireAt: void 0
      };
      this.jobs.delete(job.id);
      this.emitState(currentBeforeExecute.targetSessionName);
      this.emitEvent({
        sessionName: stoppedJob.targetSessionName,
        jobId: stoppedJob.id,
        type: "updated",
        at: now.toISOString(),
        message: "schedule removed after reaching max runs"
      });
      return stoppedJob;
    }
    if (currentBeforeExecute.execution.endAt) {
      const endAtMs = Date.parse(currentBeforeExecute.execution.endAt);
      if (!Number.isFinite(endAtMs) || endAtMs <= now.getTime()) {
        const stoppedJob = {
          ...currentBeforeExecute,
          enabled: false,
          updatedAt: now.toISOString(),
          nextFireAt: void 0
        };
        this.jobs.delete(job.id);
        this.emitState(currentBeforeExecute.targetSessionName);
        this.emitEvent({
          sessionName: stoppedJob.targetSessionName,
          jobId: stoppedJob.id,
          type: "updated",
          at: now.toISOString(),
          message: "schedule removed after end time"
        });
        return stoppedJob;
      }
    }
    const result = await (async () => {
      try {
        return await this.executeJob(job);
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : String(error)
        };
      }
    })();
    const current = this.jobs.get(job.id);
    if (!current) {
      return null;
    }
    const lastResult = result.ok ? "ok" : "error";
    const nextFiredCount = Math.max(0, Math.floor(current.execution.firedCount || 0)) + 1;
    const nextMaxRuns = Math.max(0, Math.floor(current.execution.maxRuns || 0));
    const reachedRunLimit = nextMaxRuns > 0 && nextFiredCount >= nextMaxRuns;
    const nextBase = {
      ...current,
      updatedAt: now.toISOString(),
      lastFiredAt: now.toISOString(),
      lastResult,
      lastError: result.ok ? void 0 : result.message,
      enabled: result.disable || reachedRunLimit ? false : current.enabled,
      execution: {
        ...current.execution,
        firedCount: nextFiredCount
      }
    };
    const nextJob = {
      ...nextBase,
      nextFireAt: nextBase.enabled ? computeNextFireAtForJob(nextBase, now) : void 0
    };
    if (reachedRunLimit) {
      this.jobs.delete(job.id);
    } else {
      this.jobs.set(job.id, nextJob);
    }
    this.emitState(nextJob.targetSessionName);
    this.emitEvent({
      sessionName: nextJob.targetSessionName,
      jobId: nextJob.id,
      type: result.ok ? "triggered" : "error",
      at: now.toISOString(),
      message: reachedRunLimit ? "schedule reached max runs" : result.message
    });
    return nextJob;
  }
};

// src/server/terminal-schedule-runtime.ts
function createTerminalScheduleRuntime(deps) {
  function buildScheduleStatePayload(sessionName) {
    return {
      sessionName,
      jobs: scheduleEngine2.listBySession(sessionName)
    };
  }
  function sendScheduleStateToSession2(session, sessionName = session.sessionName) {
    if (!sessionName) {
      return;
    }
    deps.sendMessage(session, {
      type: "schedule-state",
      payload: buildScheduleStatePayload(sessionName)
    });
  }
  function broadcastScheduleState(sessionName) {
    if (!sessionName) {
      return;
    }
    for (const session of deps.sessions.values()) {
      if (session.sessionName !== sessionName) {
        continue;
      }
      sendScheduleStateToSession2(session, sessionName);
    }
  }
  function broadcastScheduleEvent(event) {
    for (const session of deps.sessions.values()) {
      if (session.sessionName !== event.sessionName) {
        continue;
      }
      deps.sendMessage(session, {
        type: "schedule-event",
        payload: event
      });
    }
  }
  const scheduleEngine2 = new ScheduleEngine({
    initialJobs: deps.initialJobs,
    saveJobs: deps.saveJobs,
    executeJob: deps.executeJob,
    onStateChange: (sessionName) => {
      broadcastScheduleState(sessionName);
    },
    onEvent: (event) => {
      broadcastScheduleEvent(event);
    }
  });
  return {
    scheduleEngine: scheduleEngine2,
    sendScheduleStateToSession: sendScheduleStateToSession2,
    dispose: () => {
      scheduleEngine2.dispose();
    }
  };
}

// src/server/terminal-control-runtime.ts
var import_child_process = require("child_process");
var import_os3 = require("os");
function createTerminalControlRuntime(deps) {
  const liveMirrorInputBatches = /* @__PURE__ */ new Map();
  function cleanEnv() {
    const env = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== void 0) {
        env[key] = value;
      }
    }
    delete env.TMUX;
    delete env.TMUX_PANE;
    delete env.TMUX_TMPDIR;
    env.TERM = "xterm-256color";
    env.LANG = env.LANG || "en_US.UTF-8";
    env.LC_CTYPE = env.LC_CTYPE || env.LANG;
    const currentPath = env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin";
    env.PATH = Array.from(/* @__PURE__ */ new Set([
      "/opt/homebrew/bin",
      "/usr/local/bin",
      currentPath
    ])).join(":");
    return env;
  }
  function isTmuxNoServerForListSessions(stderr, args) {
    if (args[0] !== "list-sessions") {
      return false;
    }
    return stderr.includes("no server running on") || stderr.includes("error connecting to") && stderr.includes("No such file or directory");
  }
  function runTmux2(args) {
    if (deps.wezTermBackend) {
      throw new Error(`wezterm backend does not support tmux command: ${args.join(" ")}`);
    }
    const result = (0, import_child_process.spawnSync)(deps.tmuxBinary, args, {
      encoding: "utf-8",
      cwd: process.env.HOME || (0, import_os3.homedir)(),
      env: cleanEnv()
    });
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      const stderr = result.stderr?.trim() || "";
      if (isTmuxNoServerForListSessions(stderr, args)) {
        return { ok: true, stdout: "" };
      }
      throw new Error(stderr || `tmux exited with status ${result.status}`);
    }
    return { ok: true, stdout: result.stdout || "" };
  }
  function runCommand(command, args) {
    const result = (0, import_child_process.spawnSync)(command, args, {
      encoding: "utf-8",
      cwd: process.env.HOME || (0, import_os3.homedir)(),
      env: cleanEnv()
    });
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(result.stderr?.trim() || `${command} exited with status ${result.status}`);
    }
    return result;
  }
  function runTmuxAsync(args) {
    if (deps.wezTermBackend) {
      return Promise.reject(new Error(`wezterm backend does not support tmux command: ${args.join(" ")}`));
    }
    return new Promise((resolve4, reject) => {
      const child = (0, import_child_process.spawn)(deps.tmuxBinary, args, {
        cwd: process.env.HOME || (0, import_os3.homedir)(),
        env: cleanEnv(),
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        reject(error);
      });
      child.on("close", (code) => {
        if (code !== 0) {
          const trimmedStderr = stderr.trim();
          if (isTmuxNoServerForListSessions(trimmedStderr, args)) {
            resolve4({ ok: true, stdout: "" });
            return;
          }
          reject(new Error(trimmedStderr || `tmux exited with status ${code ?? "unknown"}`));
          return;
        }
        resolve4({ ok: true, stdout });
      });
    });
  }
  function sleepTmuxWriteSettleSync() {
    if (TERMINAL_INPUT_TMUX_WRITE_SETTLE_MS <= 0) {
      return;
    }
    Atomics.wait(
      new Int32Array(new SharedArrayBuffer(4)),
      0,
      0,
      TERMINAL_INPUT_TMUX_WRITE_SETTLE_MS
    );
  }
  function sleepTmuxWriteSettleAsync() {
    if (TERMINAL_INPUT_TMUX_WRITE_SETTLE_MS <= 0) {
      return Promise.resolve();
    }
    return new Promise((resolve4) => {
      setTimeout(resolve4, TERMINAL_INPUT_TMUX_WRITE_SETTLE_MS);
    });
  }
  function writeTmuxLiteralChunksSync(sessionName, payload) {
    const chunks = splitTerminalInputUtf8Chunks(
      payload,
      TERMINAL_INPUT_TMUX_WRITE_CHUNK_BYTES
    );
    for (let index = 0; index < chunks.length; index += 1) {
      runTmux2(["send-keys", "-t", sessionName, "-l", "--", chunks[index]]);
      if (index < chunks.length - 1) {
        sleepTmuxWriteSettleSync();
      }
    }
  }
  function ensureTmuxServerRunning() {
    if (deps.wezTermBackend) {
      return;
    }
    const keepalive = "zterm-daemon-keepalive";
    try {
      runTmux2(["has-session", "-t", keepalive]);
      return;
    } catch {
    }
    try {
      runTmux2(["new-session", "-d", "-s", keepalive, "-x", "80", "-y", "24"]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("already exists")) {
        console.warn(`[terminal-control] tmux new-session: ${message}`);
      }
    }
  }
  function writeToTmuxSession2(sessionName, payload, appendEnter2) {
    if (deps.wezTermBackend) {
      const chunks = splitTerminalInputUtf8Chunks(payload, TERMINAL_INPUT_CHUNK_BYTES);
      if (chunks.length <= 1) {
        deps.wezTermBackend.writeInput(sessionName, `${chunks[0] || ""}${appendEnter2 ? "\r" : ""}`);
        return;
      }
      for (const chunk of chunks) {
        deps.wezTermBackend.writeInput(sessionName, chunk);
      }
      if (appendEnter2) {
        deps.wezTermBackend.writeInput(sessionName, "\r");
      }
      return;
    }
    writeTmuxLiteralChunksSync(sessionName, payload);
    if (appendEnter2) {
      runTmux2(["send-keys", "-t", sessionName, "Enter"]);
    }
  }
  function writeToLiveMirror2(sessionName, payload, appendEnter2) {
    const mirror = deps.mirrors.get(deps.getMirrorKey(sessionName));
    if (!mirror || mirror.lifecycle !== "ready") {
      return false;
    }
    if (deps.wezTermBackend) {
      const chunks = splitTerminalInputUtf8Chunks(payload, TERMINAL_INPUT_CHUNK_BYTES);
      if (chunks.length <= 1) {
        deps.wezTermBackend.writeInput(sessionName, `${chunks[0] || ""}${appendEnter2 ? "\r" : ""}`);
        return true;
      }
      for (const chunk of chunks) {
        deps.wezTermBackend.writeInput(sessionName, chunk);
      }
      if (appendEnter2) {
        deps.wezTermBackend.writeInput(sessionName, "\r");
      }
      return true;
    }
    writeTmuxLiteralChunksSync(sessionName, payload);
    if (appendEnter2) {
      runTmux2(["send-keys", "-t", sessionName, "Enter"]);
    }
    return true;
  }
  function buildLiveMirrorInputGroups(items) {
    const maxGroupBytes = deps.wezTermBackend ? TERMINAL_INPUT_CHUNK_BYTES : TERMINAL_INPUT_TMUX_WRITE_CHUNK_BYTES;
    const groups = [];
    let groupPayload = "";
    let groupBytes = 0;
    const groupItems = /* @__PURE__ */ new Set();
    const flushGroup = (appendEnter2) => {
      if (!groupPayload && groupItems.size === 0 && !appendEnter2) {
        return;
      }
      groups.push({
        payload: groupPayload,
        appendEnter: appendEnter2,
        items: Array.from(groupItems)
      });
      groupPayload = "";
      groupBytes = 0;
      groupItems.clear();
    };
    for (const item of items) {
      const chunks = splitTerminalInputUtf8Chunks(item.payload, maxGroupBytes);
      if (chunks.length === 0) {
        groupItems.add(item);
        if (item.appendEnter) {
          flushGroup(true);
        }
        continue;
      }
      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index];
        const chunkBytes = getTerminalInputUtf8ByteLength(chunk);
        if (groupBytes > 0 && groupBytes + chunkBytes > maxGroupBytes) {
          flushGroup(false);
        }
        groupPayload += chunk;
        groupBytes += chunkBytes;
        groupItems.add(item);
        if (item.appendEnter && index === chunks.length - 1) {
          flushGroup(true);
        }
      }
    }
    flushGroup(false);
    return groups;
  }
  function createLiveMirrorInputGroupSettler(writableItems, groups) {
    const unresolved = new Set(writableItems);
    const failedItems = /* @__PURE__ */ new Set();
    const pendingGroupCounts = /* @__PURE__ */ new Map();
    for (const group of groups) {
      for (const item of group.items) {
        pendingGroupCounts.set(item, (pendingGroupCounts.get(item) || 0) + 1);
      }
    }
    const settleGroup = (group, value) => {
      for (const item of group.items) {
        if (!unresolved.has(item)) {
          continue;
        }
        if (!value) {
          failedItems.add(item);
        }
        const nextCount = (pendingGroupCounts.get(item) || 1) - 1;
        if (nextCount > 0) {
          pendingGroupCounts.set(item, nextCount);
          continue;
        }
        pendingGroupCounts.delete(item);
        unresolved.delete(item);
        item.resolve(!failedItems.has(item));
      }
    };
    return {
      unresolved,
      settleGroup
    };
  }
  async function flushPendingLiveMirrorInput(mirrorKey) {
    const pending = liveMirrorInputBatches.get(mirrorKey);
    if (!pending) {
      return;
    }
    if (pending.flushing) {
      return;
    }
    pending.scheduled = false;
    pending.flushing = true;
    const items = pending.items.splice(0);
    const mirror = deps.mirrors.get(mirrorKey);
    if (!mirror || mirror.lifecycle !== "ready") {
      for (const item of items) {
        item.resolve(false);
      }
      pending.flushing = false;
      if (pending.items.length === 0) {
        liveMirrorInputBatches.delete(mirrorKey);
      } else {
        schedulePendingLiveMirrorInput(mirrorKey);
      }
      return;
    }
    const writableItems = [];
    for (const item of items) {
      if (item.shouldWrite && !item.shouldWrite()) {
        item.resolve(false);
        continue;
      }
      writableItems.push(item);
    }
    if (writableItems.length === 0) {
      pending.flushing = false;
      if (pending.items.length === 0) {
        liveMirrorInputBatches.delete(mirrorKey);
      } else {
        schedulePendingLiveMirrorInput(mirrorKey);
      }
      return;
    }
    const groups = buildLiveMirrorInputGroups(writableItems);
    const { unresolved, settleGroup } = createLiveMirrorInputGroupSettler(writableItems, groups);
    const isGroupWritable = (group) => group.items.every((item) => !item.shouldWrite || item.shouldWrite());
    if (deps.wezTermBackend) {
      try {
        for (const group of groups) {
          if (!isGroupWritable(group)) {
            settleGroup(group, false);
            continue;
          }
          if (group.payload) {
            deps.wezTermBackend.writeInput(mirror.sessionName, group.payload);
          }
          if (group.appendEnter) {
            if (!isGroupWritable(group)) {
              settleGroup(group, false);
              continue;
            }
            deps.wezTermBackend.writeInput(mirror.sessionName, "\r");
          }
          settleGroup(group, true);
        }
      } catch (error) {
        for (const item of unresolved) {
          item.reject(error);
        }
      } finally {
        pending.flushing = false;
        if (pending.items.length === 0) {
          liveMirrorInputBatches.delete(mirrorKey);
        } else {
          schedulePendingLiveMirrorInput(mirrorKey);
        }
      }
      return;
    }
    try {
      for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
        const group = groups[groupIndex];
        if (!isGroupWritable(group)) {
          settleGroup(group, false);
          continue;
        }
        if (group.payload) {
          await runTmuxAsync(["send-keys", "-t", mirror.sessionName, "-l", "--", group.payload]);
        }
        if (group.appendEnter) {
          if (!isGroupWritable(group)) {
            settleGroup(group, false);
            continue;
          }
          await runTmuxAsync(["send-keys", "-t", mirror.sessionName, "Enter"]);
        }
        settleGroup(group, true);
        if (groupIndex < groups.length - 1) {
          await sleepTmuxWriteSettleAsync();
        }
      }
    } catch (error) {
      for (const item of unresolved) {
        item.reject(error);
      }
    } finally {
      pending.flushing = false;
      if (pending.items.length === 0) {
        liveMirrorInputBatches.delete(mirrorKey);
      } else {
        schedulePendingLiveMirrorInput(mirrorKey);
      }
    }
  }
  function schedulePendingLiveMirrorInput(mirrorKey) {
    const pending = liveMirrorInputBatches.get(mirrorKey);
    if (!pending || pending.scheduled || pending.flushing) {
      return;
    }
    pending.scheduled = true;
    queueMicrotask(() => flushPendingLiveMirrorInput(mirrorKey));
  }
  function enqueueLiveMirrorInput(sessionName, payload, appendEnter2, shouldWrite) {
    const mirrorKey = deps.getMirrorKey(sessionName);
    let pending = liveMirrorInputBatches.get(mirrorKey);
    if (!pending) {
      pending = {
        items: [],
        scheduled: false,
        flushing: false
      };
      liveMirrorInputBatches.set(mirrorKey, pending);
    }
    const result = new Promise((resolve4, reject) => {
      pending?.items.push({
        payload,
        appendEnter: appendEnter2,
        shouldWrite,
        resolve: resolve4,
        reject
      });
    });
    schedulePendingLiveMirrorInput(mirrorKey);
    return result;
  }
  function disposeLiveMirrorInputBatch(sessionName, reason) {
    const mirrorKey = deps.getMirrorKey(sessionName);
    const pending = liveMirrorInputBatches.get(mirrorKey);
    if (!pending) {
      return 0;
    }
    let evicted = 0;
    if (!pending.flushing) {
      const items = pending.items.splice(0);
      for (const item of items) {
        item.resolve(false);
        evicted += 1;
      }
      liveMirrorInputBatches.delete(mirrorKey);
    } else {
      const remaining = pending.items.splice(0);
      for (const item of remaining) {
        item.resolve(false);
        evicted += 1;
      }
    }
    deps.daemonRuntimeDebug?.("input-dispose", {
      mirrorKey,
      reason,
      evicted
    });
    return evicted;
  }
  function listTmuxSessions2() {
    if (deps.wezTermBackend) {
      return deps.wezTermBackend.listSessions().map((session) => session.sessionName);
    }
    const result = runTmux2(["list-sessions", "-F", "#S"]);
    return result.stdout.split("\n").map((line) => line.trim()).filter((line) => Boolean(line) && !deps.hiddenTmuxSessions.has(line));
  }
  function createDetachedTmuxSession2(input, cwd) {
    if (deps.wezTermBackend) {
      return deps.wezTermBackend.createSession({ sessionName: input, cwd }).sessionName;
    }
    const sessionName = deps.sanitizeSessionName(input || deps.defaultSessionName);
    const args = ["new-session", "-d", "-s", sessionName];
    if (cwd) {
      args.push("-c", cwd);
    }
    runTmux2(args);
    return sessionName;
  }
  function closeDetachedTerminalSession2(input) {
    const sessionName = deps.sanitizeSessionName(input);
    if (deps.wezTermBackend) {
      deps.wezTermBackend.closeSession(sessionName);
      return;
    }
    runTmux2(["kill-session", "-t", sessionName]);
  }
  function renameTmuxSession2(currentName, nextName) {
    if (deps.wezTermBackend) {
      throw new Error("wezterm backend does not support tmux rename-session");
    }
    const sessionName = deps.sanitizeSessionName(currentName);
    const nextSessionName = deps.sanitizeSessionName(nextName);
    runTmux2(["rename-session", "-t", sessionName, nextSessionName]);
    return nextSessionName;
  }
  return {
    runTmux: runTmux2,
    ensureTmuxServerRunning,
    runTmuxAsync,
    runCommand,
    writeToTmuxSession: writeToTmuxSession2,
    writeToLiveMirror: writeToLiveMirror2,
    enqueueLiveMirrorInput,
    disposeLiveMirrorInputBatch,
    listTmuxSessions: listTmuxSessions2,
    createDetachedTmuxSession: createDetachedTmuxSession2,
    closeDetachedTerminalSession: closeDetachedTerminalSession2,
    renameTmuxSession: renameTmuxSession2
  };
}

// src/server/wezterm-backend.ts
var import_child_process2 = require("child_process");
function createWezTermCommandRunner(executable) {
  function normalizeError(stderr, code) {
    const trimmed = stderr.trim();
    return trimmed || `${executable} exited with status ${code ?? "unknown"}`;
  }
  function runSpawn(args, input) {
    const result = (0, import_child_process2.spawnSync)(executable, args, {
      encoding: "utf-8",
      input,
      shell: false
    });
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(normalizeError(result.stderr || "", result.status));
    }
    return result.stdout || "";
  }
  return {
    run: (args) => runSpawn(args),
    runWithInput: (args, input) => {
      runSpawn(args, input);
    }
  };
}
function parsePositiveInteger(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`invalid wezterm ${label}: ${value}`);
  }
  return parsed;
}
function parseSize(value) {
  const match = /^(\d+)x(\d+)$/.exec(value.trim());
  if (!match) {
    throw new Error(`invalid wezterm pane size: ${value}`);
  }
  return {
    cols: parsePositiveInteger(match[1], "cols"),
    rows: parsePositiveInteger(match[2], "rows")
  };
}
function parseWezTermPaneList(raw) {
  const trimmedRaw = raw.trim();
  if (!trimmedRaw) {
    return [];
  }
  if (trimmedRaw.startsWith("[")) {
    const parsed = JSON.parse(trimmedRaw);
    if (!Array.isArray(parsed)) {
      throw new Error("invalid wezterm pane list json");
    }
    return parsed.map((pane) => {
      const rows = pane.size?.rows;
      const cols = pane.size?.cols;
      if (!Number.isFinite(pane.window_id) || !Number.isFinite(pane.tab_id) || !Number.isFinite(pane.pane_id) || !Number.isFinite(rows) || !Number.isFinite(cols) || !pane.workspace || !pane.title || !pane.cwd) {
        throw new Error(`invalid wezterm pane json row: ${JSON.stringify(pane)}`);
      }
      return {
        winId: parsePositiveInteger(String(pane.window_id), "winId"),
        tabId: parsePositiveInteger(String(pane.tab_id), "tabId"),
        paneId: parsePositiveInteger(String(pane.pane_id), "paneId"),
        workspace: pane.workspace,
        cols: parsePositiveInteger(String(cols), "cols"),
        rows: parsePositiveInteger(String(rows), "rows"),
        title: pane.title,
        cwd: pane.cwd,
        cursorX: Number.isFinite(pane.cursor_x) ? Math.max(0, Math.floor(pane.cursor_x || 0)) : void 0,
        cursorY: Number.isFinite(pane.cursor_y) ? Math.max(0, Math.floor(pane.cursor_y || 0)) : void 0,
        cursorVisibility: typeof pane.cursor_visibility === "string" ? pane.cursor_visibility : void 0,
        topRow: Number.isFinite(pane.top_row) ? Math.max(0, Math.floor(pane.top_row || 0)) : void 0
      };
    });
  }
  const lines = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length === 0) {
    return [];
  }
  const body = /^WINID\s+TABID\s+PANEID\s+WORKSPACE\s+SIZE\s+TITLE\s+CWD$/i.test(lines[0]) ? lines.slice(1) : lines;
  return body.map((line) => {
    const parts = line.split(/\s+/);
    if (parts.length < 7) {
      throw new Error(`invalid wezterm pane row: ${line}`);
    }
    const [winIdRaw, tabIdRaw, paneIdRaw, workspace, sizeRaw, title, ...cwdParts] = parts;
    const size = parseSize(sizeRaw);
    return {
      winId: parsePositiveInteger(winIdRaw, "winId"),
      tabId: parsePositiveInteger(tabIdRaw, "tabId"),
      paneId: parsePositiveInteger(paneIdRaw, "paneId"),
      workspace,
      cols: size.cols,
      rows: size.rows,
      title,
      cwd: cwdParts.join(" ")
    };
  });
}
function normalizeWezTermCursor(options) {
  if (typeof options.pane.cursorX !== "number" || typeof options.pane.cursorY !== "number") {
    return null;
  }
  const safePaneRows = Math.max(1, Math.floor(options.pane.rows || 1));
  const safeBufferStartIndex = Math.max(0, Math.floor(options.bufferStartIndex || 0));
  const safeAvailableEndIndex = Math.max(safeBufferStartIndex, Math.floor(options.availableEndIndex || 0));
  if (safeAvailableEndIndex <= safeBufferStartIndex) {
    return null;
  }
  const visibleTopIndex = Math.max(safeBufferStartIndex, safeAvailableEndIndex - safePaneRows);
  return {
    rowIndex: Math.max(
      visibleTopIndex,
      Math.min(safeAvailableEndIndex - 1, visibleTopIndex + Math.max(0, Math.floor(options.pane.cursorY || 0)))
    ),
    col: Math.max(0, Math.floor(options.pane.cursorX || 0)),
    visible: options.pane.cursorVisibility !== "Hidden"
  };
}
function stripAnsiControlSequences(line) {
  return line.replace(/\x1b\[[0-9;:]*[A-Za-z]/g, "");
}
function normalizeWezTermGetTextLines(raw) {
  const lines = normalizeCapturedLineBlock(raw);
  let end = lines.length;
  while (end > 0 && stripAnsiControlSequences(lines[end - 1]).trim().length === 0) {
    end -= 1;
  }
  return end === lines.length ? lines : lines.slice(0, end);
}
function resolveNextStartIndex(options) {
  const previousStartIndex = Math.max(0, Math.floor(options.previousStartIndex || 0));
  const previousLineCount = Math.max(0, Math.floor(options.previousLineCount || 0));
  const nextLineCount = Math.max(0, Math.floor(options.nextLineCount || 0));
  const trimmedLineCount = Math.max(0, Math.floor(options.trimmedLineCount || 0));
  if (trimmedLineCount > 0) {
    const previousEndIndex = previousStartIndex + previousLineCount;
    const nextEndIndex = Math.max(previousEndIndex, previousStartIndex + nextLineCount);
    return Math.max(0, nextEndIndex - (nextLineCount - trimmedLineCount));
  }
  return previousStartIndex;
}
async function buildWezTermMirrorSnapshot(options) {
  const maxMirrorLines = Math.max(1, Math.floor(options.maxMirrorLines || 1e3));
  const rawLines = normalizeWezTermGetTextLines(options.getTextEscapes);
  const canonicalLines = await canonicalizeCapturedMirrorLines(rawLines, options.pane.cols);
  const trimmed = trimCanonicalBufferWindow(0, canonicalLines, maxMirrorLines);
  const trimmedLineCount = canonicalLines.length - trimmed.lines.length;
  const bufferStartIndex = resolveNextStartIndex({
    previousStartIndex: options.previousStartIndex || 0,
    previousLineCount: options.previousLineCount || 0,
    nextLineCount: canonicalLines.length,
    trimmedLineCount
  });
  const availableEndIndex = bufferStartIndex + trimmed.lines.length;
  return {
    revision: Math.max(0, Math.floor(options.revision || 0)),
    bufferStartIndex,
    bufferLines: trimmed.lines,
    cols: options.pane.cols,
    rows: options.pane.rows,
    cursorKeysApp: false,
    cursor: normalizeWezTermCursor({
      pane: options.pane,
      bufferStartIndex,
      availableEndIndex
    })
  };
}
function buildWezTermSendTextArgs(paneId) {
  const normalizedPaneId = Math.max(0, Math.floor(paneId));
  if (!Number.isFinite(normalizedPaneId) || normalizedPaneId <= 0) {
    throw new Error(`invalid wezterm paneId for input: ${paneId}`);
  }
  return ["cli", "--prefer-mux", "send-text", "--pane-id", String(normalizedPaneId), "--no-paste"];
}
function buildWezTermListArgs() {
  return ["cli", "--prefer-mux", "list", "--format", "json"];
}
function buildWezTermSpawnArgs(input) {
  const workspace = input.workspace.trim();
  if (!workspace) {
    throw new Error("wezterm workspace is required");
  }
  if (input.command.length === 0 || input.command.some((item) => !item.trim())) {
    throw new Error("wezterm spawn command is required");
  }
  const args = ["cli", "--prefer-mux", "spawn", "--new-window", "--workspace", workspace];
  if (input.cwd?.trim()) {
    args.push("--cwd", input.cwd.trim());
  }
  args.push("--", ...input.command);
  return args;
}
function buildWezTermPersistentShellCommand(command) {
  const candidate = command?.filter((item) => item.trim());
  if (!candidate?.length) {
    return ["cmd.exe", "/k"];
  }
  const executable = candidate[0]?.trim().toLowerCase() || "";
  const firstArg = candidate[1]?.trim().toLowerCase() || "";
  if ((executable === "cmd" || executable === "cmd.exe") && firstArg === "/c") {
    throw new Error("wezterm sessions must use a persistent shell; cmd.exe /c would close the pane when the child process exits");
  }
  return candidate;
}
function buildWezTermGetTextArgs(input) {
  const normalizedPaneId = Math.max(0, Math.floor(input.paneId));
  if (!Number.isFinite(normalizedPaneId) || normalizedPaneId <= 0) {
    throw new Error(`invalid wezterm paneId for get-text: ${input.paneId}`);
  }
  return [
    "cli",
    "--prefer-mux",
    "get-text",
    "--pane-id",
    String(normalizedPaneId),
    "--start-line",
    String(input.startLine ?? -1e3),
    "--end-line",
    String(input.endLine ?? 1e3),
    "--escapes"
  ];
}
function buildWezTermKillPaneArgs(paneId) {
  const normalizedPaneId = Math.max(0, Math.floor(paneId));
  if (!Number.isFinite(normalizedPaneId) || normalizedPaneId <= 0) {
    throw new Error(`invalid wezterm paneId for kill-pane: ${paneId}`);
  }
  return ["cli", "--prefer-mux", "kill-pane", "--pane-id", String(normalizedPaneId)];
}
function sanitizeWezTermSessionName(input, fallback) {
  const normalized = input.trim().replace(/[^A-Za-z0-9_.:-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || fallback;
}
function paneToBackendSession(pane, workspacePrefix) {
  const fallback = `wezterm-pane-${pane.paneId}`;
  const workspaceName = pane.workspace.startsWith(workspacePrefix) ? pane.workspace.slice(workspacePrefix.length) : pane.workspace;
  return {
    sessionName: sanitizeWezTermSessionName(workspaceName, fallback),
    paneId: pane.paneId,
    workspace: pane.workspace,
    title: pane.title,
    cwd: pane.cwd,
    cols: pane.cols,
    rows: pane.rows
  };
}
function pickSpawnPaneId(output) {
  const matches = output.match(/\b\d+\b/g);
  if (!matches?.length) {
    throw new Error(`wezterm spawn did not return a pane id: ${output}`);
  }
  return Number.parseInt(matches[matches.length - 1], 10);
}
function createWezTermBackendRuntime(options) {
  const workspacePrefix = options.workspacePrefix || "zterm-";
  const defaultCommand = buildWezTermPersistentShellCommand(options.defaultCommand);
  const maxMirrorLines = options.maxMirrorLines || 1e3;
  const sessionPaneIds = /* @__PURE__ */ new Map();
  const snapshotState = /* @__PURE__ */ new Map();
  function listPaneRecords() {
    return parseWezTermPaneList(options.runner.run(buildWezTermListArgs()));
  }
  function listSessions() {
    return listPaneRecords().map((pane) => paneToBackendSession(pane, workspacePrefix));
  }
  function resolvePaneRecord(sessionName) {
    const session = resolveSession(sessionName);
    const pane = listPaneRecords().find((candidate) => candidate.paneId === session.paneId);
    if (!pane) {
      throw new Error(`wezterm session not found: ${session.sessionName}`);
    }
    return pane;
  }
  function resolveSession(sessionName) {
    const normalizedSessionName = sanitizeWezTermSessionName(sessionName, "");
    if (!normalizedSessionName) {
      throw new Error("wezterm sessionName is required");
    }
    const explicitPaneId = sessionPaneIds.get(normalizedSessionName);
    const sessions2 = listSessions();
    const matched = explicitPaneId ? sessions2.find((session) => session.paneId === explicitPaneId) : sessions2.find((session) => session.sessionName === normalizedSessionName);
    if (!matched) {
      throw new Error(`wezterm session not found: ${normalizedSessionName}`);
    }
    sessionPaneIds.set(normalizedSessionName, matched.paneId);
    return matched;
  }
  function createSession(input) {
    const sessionName = sanitizeWezTermSessionName(input?.sessionName || "cmd", "cmd");
    const workspace = `${workspacePrefix}${sessionName}`;
    const paneId = pickSpawnPaneId(options.runner.run(buildWezTermSpawnArgs({
      workspace,
      cwd: input?.cwd,
      command: input?.command?.length ? buildWezTermPersistentShellCommand(input.command) : defaultCommand
    })));
    sessionPaneIds.set(sessionName, paneId);
    const pane = listPaneRecords().find((candidate) => candidate.paneId === paneId);
    if (!pane) {
      throw new Error(`created wezterm pane is not listed: ${paneId}`);
    }
    return paneToBackendSession(pane, workspacePrefix);
  }
  async function readSnapshot(sessionName) {
    const session = resolveSession(sessionName);
    const pane = resolvePaneRecord(session.sessionName);
    const state = snapshotState.get(session.sessionName) || {
      revision: 0,
      previousStartIndex: 0,
      previousLineCount: 0
    };
    const text = options.runner.run(buildWezTermGetTextArgs({ paneId: session.paneId }));
    const snapshot = await buildWezTermMirrorSnapshot({
      pane,
      revision: state.revision + 1,
      previousStartIndex: state.previousStartIndex,
      previousLineCount: state.previousLineCount,
      getTextEscapes: text,
      maxMirrorLines
    });
    snapshotState.set(session.sessionName, {
      revision: snapshot.revision,
      previousStartIndex: snapshot.bufferStartIndex,
      previousLineCount: snapshot.bufferLines.length
    });
    return snapshot;
  }
  function writeInput(sessionName, input) {
    const session = resolveSession(sessionName);
    options.runner.runWithInput(buildWezTermSendTextArgs(session.paneId), input);
  }
  function closeSession(sessionName) {
    const session = resolveSession(sessionName);
    options.runner.run(buildWezTermKillPaneArgs(session.paneId));
    const paneStillExists = listPaneRecords().some((pane) => pane.paneId === session.paneId);
    if (paneStillExists) {
      throw new Error(`wezterm pane cleanup failed: ${session.sessionName} pane ${session.paneId} still listed`);
    }
    sessionPaneIds.delete(session.sessionName);
    snapshotState.delete(session.sessionName);
  }
  function readCurrentPath(sessionName) {
    return resolveSession(sessionName).cwd;
  }
  return {
    listSessions,
    createSession,
    readSnapshot,
    writeInput,
    closeSession,
    readCurrentPath
  };
}

// src/server/terminal-backend-selection.ts
function resolveTerminalBackendKind(options = {}) {
  const env = options.env || process.env;
  const explicit = (env.ZTERM_TERMINAL_BACKEND || "").trim().toLowerCase();
  if (explicit === "tmux" || explicit === "wezterm") {
    return explicit;
  }
  if (explicit) {
    throw new Error(`unsupported ZTERM_TERMINAL_BACKEND: ${explicit}`);
  }
  return (options.platform || process.platform) === "win32" ? "wezterm" : "tmux";
}
function resolveWezTermExecutable(env = process.env) {
  const explicit = (env.ZTERM_WEZTERM_EXE || "").trim();
  if (explicit) {
    return explicit;
  }
  return "wezterm.exe";
}

// src/server/terminal-debug-runtime.ts
function createTerminalDebugRuntime(deps) {
  let daemonRuntimeDebugEnabled = deps.daemonRuntimeDebugEnabled;
  let daemonRuntimeDebugSeq = 0;
  function formatLocalLogTimestamp(date = /* @__PURE__ */ new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    const seconds = String(date.getSeconds()).padStart(2, "0");
    const millis = String(date.getMilliseconds()).padStart(3, "0");
    const timezoneOffsetMinutes = -date.getTimezoneOffset();
    const sign = timezoneOffsetMinutes >= 0 ? "+" : "-";
    const timezoneHours = String(Math.floor(Math.abs(timezoneOffsetMinutes) / 60)).padStart(2, "0");
    const timezoneMinutes = String(Math.abs(timezoneOffsetMinutes) % 60).padStart(2, "0");
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${millis} ${sign}${timezoneHours}:${timezoneMinutes}`;
  }
  function logTimePrefix2(date = /* @__PURE__ */ new Date()) {
    return formatLocalLogTimestamp(date);
  }
  function setDaemonRuntimeDebugEnabled2(enabled) {
    daemonRuntimeDebugEnabled = enabled;
  }
  function sanitizeDaemonDebugPayload(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return {};
    }
    const source = payload;
    const sanitized = {};
    for (const key of [
      "transportId",
      "sessionId",
      "sessionName",
      "reason",
      "bytes",
      "durationMs",
      "queueDepth",
      "type",
      "payloadSummary"
    ]) {
      if (source[key] !== void 0) {
        sanitized[key] = source[key];
      }
    }
    if (source.payloadSummary && typeof source.payloadSummary === "object" && !Array.isArray(source.payloadSummary)) {
      sanitized.payloadSummary = source.payloadSummary;
    }
    return sanitized;
  }
  function stringifyDaemonDebugPayload(payload) {
    const text = JSON.stringify(payload);
    return truncateDaemonLogPayload(text, deps.maxClientDebugLogPayloadChars);
  }
  function daemonRuntimeDebug2(scope, payload) {
    if (!daemonRuntimeDebugEnabled) {
      return;
    }
    const timestamp = logTimePrefix2();
    const sanitizedPayload = sanitizeDaemonDebugPayload(payload);
    const sessionId = typeof sanitizedPayload.sessionId === "string" && sanitizedPayload.sessionId.trim() ? sanitizedPayload.sessionId.trim() : "daemon";
    const tmuxSessionName = typeof sanitizedPayload.sessionName === "string" && sanitizedPayload.sessionName.trim() ? sanitizedPayload.sessionName.trim() : "daemon";
    const payloadText = Object.keys(sanitizedPayload).length > 0 ? stringifyDaemonDebugPayload(sanitizedPayload) : "";
    deps.daemonRuntimeDebugStore.appendBatch(
      {
        sessionId,
        tmuxSessionName
      },
      [{
        seq: ++daemonRuntimeDebugSeq,
        ts: timestamp,
        scope,
        payload: payloadText
      }]
    );
    if (payloadText) {
      console.debug(`[daemon-runtime:${scope}] ${timestamp}`, payloadText);
      return;
    }
    console.debug(`[daemon-runtime:${scope}] ${timestamp}`);
  }
  function truncateDaemonLogPayload(value, maxChars) {
    if (value.length <= maxChars) {
      return value;
    }
    return `${value.slice(0, Math.max(0, maxChars - 12))}\u2026[truncated]`;
  }
  function normalizeClientDebugEntries(entries) {
    return entries.filter((entry) => entry && typeof entry === "object" && typeof entry.scope === "string").slice(0, deps.maxClientDebugBatchLogEntries).map((entry) => ({
      seq: typeof entry.seq === "number" && Number.isFinite(entry.seq) ? entry.seq : 0,
      ts: typeof entry.ts === "string" ? entry.ts : logTimePrefix2(),
      scope: truncateDaemonLogPayload(entry.scope, 120),
      payload: typeof entry.payload === "string" && entry.payload.length > 0 ? truncateDaemonLogPayload(entry.payload, deps.maxClientDebugLogPayloadChars) : ""
    }));
  }
  function handleClientDebugLog2(session, payload) {
    const entries = normalizeClientDebugEntries(Array.isArray(payload.entries) ? payload.entries : []);
    if (entries.length === 0) {
      return;
    }
    deps.clientRuntimeDebugStore.appendBatch(
      {
        sessionId: session.id,
        tmuxSessionName: session.sessionName || "unknown",
        requestOrigin: session.transport?.requestOrigin
      },
      entries
    );
    console.log(
      `[${logTimePrefix2()}] [client-debug] session=${session.id} tmux=${session.sessionName || "unknown"} entries=${entries.length}`
    );
    for (const entry of entries) {
      console.log(
        `[${logTimePrefix2()}] [client-debug:${entry.scope}] seq=${entry.seq} ts=${entry.ts} session=${session.id} ${entry.payload}`
      );
    }
  }
  function handleClientDebugSnapshot2(session, payload) {
    deps.clientRuntimeDebugStore.setSnapshot(
      {
        sessionId: session.id,
        tmuxSessionName: session.sessionName || "unknown",
        requestOrigin: session.transport?.requestOrigin
      },
      payload.snapshot ?? null
    );
    console.log(
      `[${logTimePrefix2()}] [client-debug-snapshot] session=${session.id} tmux=${session.sessionName || "unknown"}`
    );
  }
  function summarizePayload2(message) {
    if (message.type !== "buffer-sync") {
      return null;
    }
    const payload = message.payload;
    const firstLine = payload.lines[0];
    const lastLine = payload.lines[payload.lines.length - 1];
    return {
      revision: payload.revision,
      startIndex: payload.startIndex,
      endIndex: payload.endIndex,
      rows: payload.rows,
      cols: payload.cols,
      lineCount: payload.lines.length,
      firstLineIndex: firstLine ? "i" in firstLine ? firstLine.i : firstLine.index : null,
      lastLineIndex: lastLine ? "i" in lastLine ? lastLine.i : lastLine.index : null
    };
  }
  return {
    logTimePrefix: logTimePrefix2,
    daemonRuntimeDebug: daemonRuntimeDebug2,
    setDaemonRuntimeDebugEnabled: setDaemonRuntimeDebugEnabled2,
    summarizePayload: summarizePayload2,
    handleClientDebugLog: handleClientDebugLog2,
    handleClientDebugSnapshot: handleClientDebugSnapshot2
  };
}

// src/server/terminal-core-support.ts
function createTerminalCoreSupport(deps) {
  function resolveMirrorCacheLines2(rows) {
    const paneRows = Math.max(1, Math.floor(rows || 1));
    if (!Number.isFinite(deps.maxCapturedScrollbackLines) || deps.maxCapturedScrollbackLines <= 0) {
      return paneRows;
    }
    return Math.max(paneRows, Math.floor(deps.maxCapturedScrollbackLines));
  }
  function sanitizeSessionName2(input) {
    const candidate = (input || deps.defaultSessionName).trim();
    const normalized = candidate.replace(/[^a-zA-Z0-9:_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
    return normalized || deps.defaultSessionName;
  }
  function getMirrorKey2(sessionName) {
    return sanitizeSessionName2(sessionName);
  }
  function mirrorCursorEqual2(left, right) {
    if (!left && !right) {
      return true;
    }
    if (!left || !right) {
      return false;
    }
    return left.rowIndex === right.rowIndex && left.col === right.col && left.visible === right.visible;
  }
  function normalizeTerminalCols2(cols) {
    if (!Number.isFinite(cols) || cols <= 0) {
      throw new Error("terminal cols must be a finite positive number");
    }
    return Math.max(1, Math.floor(cols));
  }
  function normalizeTerminalRows2(rows) {
    if (!Number.isFinite(rows) || rows <= 0) {
      throw new Error("terminal rows must be a finite positive number");
    }
    return Math.max(1, Math.floor(rows));
  }
  function normalizeBufferSyncRequestPayload2(session, request) {
    const localStartIndex = Number.isFinite(request.localStartIndex) ? Math.max(0, Math.floor(request.localStartIndex)) : 0;
    if (!Number.isFinite(request.requestStartIndex) || !Number.isFinite(request.requestEndIndex)) {
      throw new Error(`buffer-sync-request missing request window for session ${session.id}`);
    }
    const requestStartIndex = Math.max(0, Math.floor(request.requestStartIndex));
    const requestEndIndex = Math.max(0, Math.floor(request.requestEndIndex));
    return {
      knownRevision: Number.isFinite(request.knownRevision) ? Math.max(0, Math.floor(request.knownRevision)) : 0,
      localStartIndex,
      localEndIndex: Number.isFinite(request.localEndIndex) ? Math.max(localStartIndex, Math.floor(request.localEndIndex)) : localStartIndex,
      requestStartIndex,
      requestEndIndex: Math.max(requestStartIndex, requestEndIndex),
      targetHeadRevision: Number.isFinite(request.targetHeadRevision || 0) ? Math.max(0, Math.floor(request.targetHeadRevision || 0)) : 0,
      missingRanges: request.missingRanges
    };
  }
  return {
    resolveMirrorCacheLines: resolveMirrorCacheLines2,
    sanitizeSessionName: sanitizeSessionName2,
    getMirrorKey: getMirrorKey2,
    mirrorCursorEqual: mirrorCursorEqual2,
    normalizeTerminalCols: normalizeTerminalCols2,
    normalizeTerminalRows: normalizeTerminalRows2,
    normalizeBufferSyncRequestPayload: normalizeBufferSyncRequestPayload2
  };
}

// src/server/terminal-daemon-runtime.ts
var import_fs6 = require("fs");
function resolveTmuxBinary() {
  const override = process.env.ZTERM_TMUX_BINARY?.trim();
  if (override) {
    return override;
  }
  const candidates = [
    "/opt/homebrew/bin/tmux",
    "/usr/local/bin/tmux",
    "/usr/bin/tmux",
    "tmux"
  ];
  const existingCandidate = candidates.find((candidate) => candidate === "tmux" || (0, import_fs6.existsSync)(candidate));
  return existingCandidate || "tmux";
}
function createTerminalDaemonRuntime(deps) {
  let heartbeatTimer = null;
  let memoryGuardTimer = null;
  let shutdownInFlight = false;
  function clearHeartbeatLoop() {
    if (!heartbeatTimer) {
      return;
    }
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  function clearMemoryGuardLoop() {
    if (!memoryGuardTimer) {
      return;
    }
    clearInterval(memoryGuardTimer);
    memoryGuardTimer = null;
  }
  function extractAuthToken2(rawUrl) {
    try {
      const url = new URL(rawUrl || "/", "ws://localhost");
      return url.searchParams.get("token")?.trim() || "";
    } catch (error) {
      console.warn(
        `[${deps.logTimePrefix()}] failed to parse websocket auth token from "${rawUrl || ""}": ${error instanceof Error ? error.message : String(error)}`
      );
      return "";
    }
  }
  function startHeartbeatLoop2() {
    if (heartbeatTimer) {
      return;
    }
    heartbeatTimer = setInterval(() => {
      const now = Date.now();
      for (const connection of deps.connections.values()) {
        const boundSubscriberIds = /* @__PURE__ */ new Set();
        if (connection.boundSubscriberId) {
          boundSubscriberIds.add(connection.boundSubscriberId);
        }
        for (const subscriberId of connection.muxChannels?.values() || []) {
          boundSubscriberIds.add(subscriberId);
        }
        if (connection.transport.readyState === import_websocket.default.OPEN && boundSubscriberIds.size > 0) {
          const lastInboundAt = Math.max(0, Math.floor(connection.lastInboundAt || 0));
          const staleForMs = lastInboundAt > 0 ? now - lastInboundAt : Number.POSITIVE_INFINITY;
          if (staleForMs > TERMINAL_TRANSPORT_STALE_INBOUND_MS) {
            const reason = "transport heartbeat stale";
            console.warn(
              `[${deps.logTimePrefix()}] transport ${connection.id} stale inbound heartbeat kind=${connection.transport.kind} staleForMs=${Math.floor(staleForMs)}`
            );
            for (const subscriberId of boundSubscriberIds) {
              const subscriber = deps.sessions.get(subscriberId) || null;
              if (!subscriber) {
                continue;
              }
              deps.detachSubscriberTransportOnly(subscriber, reason, connection.transportId);
            }
            connection.muxChannels?.clear();
            try {
              connection.closeTransport(reason);
            } catch (error) {
              console.warn(
                `[${deps.logTimePrefix()}] failed to close stale transport ${connection.id}: ${error instanceof Error ? error.message : String(error)}`
              );
            }
            deps.connections.delete(connection.id);
            continue;
          }
        }
        if (connection.transport.kind !== "ws" || connection.transport.readyState !== import_websocket.default.OPEN) {
          continue;
        }
        if (!connection.wsAlive) {
          console.warn(`[${deps.logTimePrefix()}] transport ${connection.id} heartbeat missed pong`);
        }
        connection.wsAlive = false;
        try {
          connection.transport.ping?.();
        } catch (error) {
          console.warn(
            `[${deps.logTimePrefix()}] transport ${connection.id} heartbeat ping failed: ${error instanceof Error ? error.message : String(error)}`
          );
          connection.transport.close("heartbeat ping failed");
        }
      }
    }, deps.wsHeartbeatIntervalMs);
    heartbeatTimer.unref?.();
  }
  function startMemoryGuardLoop2() {
    if (memoryGuardTimer) {
      return;
    }
    memoryGuardTimer = setInterval(() => {
      const usage = process.memoryUsage();
      if (usage.rss < deps.memoryGuardMaxRssBytes && usage.heapUsed < deps.memoryGuardMaxHeapUsedBytes) {
        return;
      }
      console.error(
        `[${deps.logTimePrefix()}] daemon memory guard tripped: rss=${usage.rss} heapUsed=${usage.heapUsed} sessions=${deps.sessions.size} mirrors=${deps.mirrors.size}`
      );
      shutdownDaemon2("memory guard", 70);
    }, deps.memoryGuardIntervalMs);
    memoryGuardTimer.unref?.();
  }
  function shutdownDaemon2(reason, exitCode = 0) {
    if (shutdownInFlight) {
      return;
    }
    shutdownInFlight = true;
    console.log(`[${deps.logTimePrefix()}] daemon shutdown start: ${reason}`);
    clearHeartbeatLoop();
    clearMemoryGuardLoop();
    deps.disposeScheduleRuntime();
    deps.disposeRelayHostClient();
    for (const connection of deps.connections.values()) {
      try {
        connection.closeTransport(reason);
      } catch (error) {
        console.warn(
          `[${deps.logTimePrefix()}] failed to close transport ${connection.id} during daemon shutdown: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    deps.connections.clear();
    deps.shutdownTerminalSessions(deps.sessions, reason);
    for (const mirror of [...deps.mirrors.values()]) {
      deps.destroyMirror(mirror, reason, {
        closeTransportSubscribers: true,
        notifyClientClose: true
      });
    }
    const finalize = () => {
      process.exit(exitCode);
    };
    try {
      deps.wss.close();
    } catch (error) {
      console.warn(`[${deps.logTimePrefix()}] websocket server close failed:`, error);
    }
    deps.server.close((error) => {
      if (error) {
        console.warn(`[${deps.logTimePrefix()}] http server close failed: ${error.message}`);
      }
      finalize();
    });
    setTimeout(finalize, 1500).unref?.();
  }
  function handleDaemonServerClosed2() {
    clearHeartbeatLoop();
    clearMemoryGuardLoop();
    deps.disposeScheduleRuntime();
    deps.disposeRelayHostClient();
    deps.disposeRtcBridgeServer();
  }
  function handleDaemonServerError2(error) {
    if (error.code === "EADDRINUSE") {
      console.error(
        `[${deps.logTimePrefix()}] daemon listen conflict on ${deps.host}:${deps.port}; another process is already bound to this port`
      );
      shutdownDaemon2("listen conflict", deps.startupPortConflictExitCode);
      return;
    }
    console.error(
      `[${deps.logTimePrefix()}] daemon server error: ${error instanceof Error ? error.message : String(error)}`
    );
    shutdownDaemon2("server error", 1);
  }
  function handleDaemonServerListening2() {
    deps.startRelayHostClient();
    console.log(`[${deps.logTimePrefix()}] zterm tmux bridge listening on ws://${deps.host}:${deps.port}`);
    console.log(`  - health: http://${deps.host}:${deps.port}/health`);
    console.log(`  - rtc signal: ws://${deps.host}:${deps.port}/signal${deps.requiredAuthToken ? "?token=<auth>" : ""}`);
    console.log(`  - runtime debug snapshot: http://${deps.host}:${deps.port}/debug/runtime${deps.requiredAuthToken ? "?token=<auth>" : ""}`);
    console.log(`  - runtime debug logs: http://${deps.host}:${deps.port}/debug/runtime/logs${deps.requiredAuthToken ? "?token=<auth>&limit=200" : "?limit=200"}`);
    console.log(`  - runtime debug control: http://${deps.host}:${deps.port}/debug/runtime/control${deps.requiredAuthToken ? "?token=<auth>&enabled=1" : "?enabled=1"}`);
    console.log(`  - updates manifest: http://${deps.host}:${deps.port}/updates/latest.json`);
    console.log(`  - updates dir: ${deps.updatesDir}`);
    console.log(`  - tmux binary: ${deps.tmuxBinary}`);
    console.log(`  - default session: ${deps.defaultSessionName}`);
    console.log(`  - active logs: ${deps.logDir}`);
    console.log(`  - auth: ${deps.authLabel}`);
    console.log(`  - config: ${deps.configDisplayPath}`);
    console.log(`  - terminal cache lines: ${deps.terminalCacheLines}`);
    console.log(`  - traversal relay: ${deps.relayLabel}`);
  }
  return {
    extractAuthToken: extractAuthToken2,
    startHeartbeatLoop: startHeartbeatLoop2,
    startMemoryGuardLoop: startMemoryGuardLoop2,
    shutdownDaemon: shutdownDaemon2,
    handleDaemonServerClosed: handleDaemonServerClosed2,
    handleDaemonServerError: handleDaemonServerError2,
    handleDaemonServerListening: handleDaemonServerListening2
  };
}

// src/server/rtc-bridge.ts
var import_wrtc = __toESM(require_lib2(), 1);
var { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate } = import_wrtc.default;
var CONNECTING = 0;
var OPEN = 1;
var CLOSING = 2;
var CLOSED = 3;
function resolveRtcIceTransportPolicy(value) {
  return value === "relay" ? "relay" : "all";
}
function buildRtcPeerConnectionConfig(payload) {
  return {
    iceServers: Array.isArray(payload?.iceServers) ? payload.iceServers : [],
    iceTransportPolicy: resolveRtcIceTransportPolicy(payload?.iceTransportPolicy)
  };
}
var RtcPeerTransport = class {
  constructor(id, requestOrigin) {
    this.requestOrigin = requestOrigin;
    this.id = id;
  }
  requestOrigin;
  id;
  channel = null;
  peerConnection = null;
  handlers = null;
  get readyState() {
    if (this.channel?.readyState === "open") {
      return OPEN;
    }
    if (this.channel?.readyState === "closing") {
      return CLOSING;
    }
    if (this.channel?.readyState === "closed") {
      return CLOSED;
    }
    return CONNECTING;
  }
  get bufferedAmount() {
    return Math.max(0, Math.floor(this.channel?.bufferedAmount || 0));
  }
  attach(peerConnection, channel, handlers) {
    this.peerConnection = peerConnection;
    this.channel = channel;
    this.handlers = handlers;
    channel.binaryType = "arraybuffer";
    channel.onmessage = (event) => {
      const value = event.data;
      if (typeof value === "string") {
        handlers.onMessage(this.id, Buffer.from(value, "utf8"), false);
        return;
      }
      if (value instanceof ArrayBuffer) {
        handlers.onMessage(this.id, Buffer.from(value), true);
        return;
      }
      if (ArrayBuffer.isView(value)) {
        handlers.onMessage(this.id, Buffer.from(value.buffer, value.byteOffset, value.byteLength), true);
        return;
      }
      handlers.onMessage(this.id, Buffer.from(String(value)), false);
    };
    channel.onclose = () => {
      handlers.onClose(this.id, "rtc data channel closed");
    };
    channel.onerror = () => {
      handlers.onError?.(this.id, "rtc data channel error");
    };
  }
  sendText(text) {
    this.channel?.send(text);
  }
  close(reason = "rtc close") {
    try {
      this.channel?.close();
    } catch (error) {
      console.warn("[rtc-bridge] Failed to close RTC data channel:", error);
    }
    try {
      this.peerConnection?.close();
    } catch (error) {
      console.warn("[rtc-bridge] Failed to close RTC peer connection:", error);
    }
    this.handlers?.onClose(this.id, reason);
  }
};
function createRtcBridgeServer(options) {
  const peers = /* @__PURE__ */ new Map();
  function upsertPeerTransport(peerId, requestOrigin, emitSignal, closeSignal) {
    const existing = peers.get(peerId);
    if (existing) {
      existing.emitSignal = emitSignal;
      existing.closeSignal = closeSignal;
      return existing;
    }
    const created = {
      requestOrigin,
      transport: new RtcPeerTransport(peerId, requestOrigin),
      peerConnection: null,
      ready: false,
      emitSignal,
      closeSignal,
      signalChain: Promise.resolve(),
      offerAccepted: false,
      pendingIceCandidates: []
    };
    peers.set(peerId, created);
    return created;
  }
  function closePeer(peerId, reason) {
    const peer = peers.get(peerId);
    if (!peer) {
      return;
    }
    try {
      peer.peerConnection?.close();
    } catch (error) {
      console.warn(`[rtc-bridge] Failed to close peer connection for ${peerId}:`, error);
    }
    try {
      peer.closeSignal(reason);
    } catch (error) {
      console.warn(`[rtc-bridge] Failed to close signal socket for ${peerId}:`, error);
    }
    peers.delete(peerId);
  }
  function initializePeerConnection(peer, payload) {
    if (peer.peerConnection || peer.ready) {
      peer.transport.close("rtc peer replaced by new init");
    }
    peer.peerConnection = null;
    peer.ready = false;
    peer.offerAccepted = false;
    peer.pendingIceCandidates = [];
    const peerConnection = new RTCPeerConnection(buildRtcPeerConnectionConfig(payload));
    peer.peerConnection = peerConnection;
    peerConnection.onicecandidate = (event) => {
      if (!event.candidate) {
        return;
      }
      peer.emitSignal({
        type: "rtc-candidate",
        payload: event.candidate.toJSON()
      });
    };
    peerConnection.ondatachannel = (event) => {
      const channel = event.channel;
      channel.onopen = () => {
        if (peer.ready || !peer.peerConnection) {
          return;
        }
        peer.ready = true;
        const handlers = options.onTransportOpen(peer.transport);
        peer.transport.attach(peer.peerConnection, channel, handlers);
      };
    };
  }
  async function flushPendingIceCandidates(peer) {
    if (!peer.peerConnection || peer.pendingIceCandidates.length === 0) {
      return;
    }
    const pending = peer.pendingIceCandidates.splice(0);
    for (const candidate of pending) {
      await peer.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    }
  }
  async function processSignalMessage(input) {
    const peer = upsertPeerTransport(input.peerId, input.requestOrigin, input.emitSignal, input.closeSignal);
    const { message } = input;
    if (message.type === "rtc-close") {
      closePeer(input.peerId, "rtc close");
      return;
    }
    if (message.type === "rtc-init") {
      initializePeerConnection(peer, message.payload);
      return;
    }
    if (!peer.peerConnection) {
      peer.emitSignal({
        type: "rtc-error",
        payload: { message: "rtc peer not initialized" }
      });
      return;
    }
    if (message.type === "rtc-offer") {
      if (peer.offerAccepted) {
        return;
      }
      peer.offerAccepted = true;
      const sdp = typeof message.payload?.sdp === "string" ? message.payload.sdp : "";
      await peer.peerConnection.setRemoteDescription(new RTCSessionDescription({ type: "offer", sdp }));
      const answer = await peer.peerConnection.createAnswer();
      await peer.peerConnection.setLocalDescription(answer);
      await flushPendingIceCandidates(peer);
      peer.emitSignal({
        type: "rtc-answer",
        payload: { sdp: answer.sdp, type: answer.type }
      });
      return;
    }
    if (message.type === "rtc-candidate" && message.payload?.candidate) {
      const candidate = message.payload;
      if (!peer.offerAccepted || !peer.peerConnection.remoteDescription) {
        peer.pendingIceCandidates.push(candidate);
        return;
      }
      await peer.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    }
  }
  async function handleSignalMessage(input) {
    const peer = upsertPeerTransport(input.peerId, input.requestOrigin, input.emitSignal, input.closeSignal);
    const next = peer.signalChain.catch(() => void 0).then(async () => {
      try {
        await processSignalMessage(input);
      } catch (error) {
        peer.emitSignal({
          type: "rtc-error",
          payload: { message: error instanceof Error ? error.message : "rtc signaling error" }
        });
      }
    });
    peer.signalChain = next.catch(() => void 0);
    await next;
  }
  return {
    handleSignalConnection(signalSocket, requestOrigin) {
      const peerId = globalThis.crypto?.randomUUID?.() || `rtc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const emitSignal = (message) => {
        if (signalSocket.readyState !== import_websocket.default.OPEN) {
          return;
        }
        signalSocket.send(JSON.stringify(message));
      };
      const closeSignal = (reason) => {
        try {
          if (signalSocket.readyState < import_websocket.default.CLOSING) {
            signalSocket.close(1e3, reason);
          }
        } catch (error) {
          console.warn("[rtc-bridge] Failed to close signaling websocket:", error);
        }
      };
      signalSocket.on("message", async (rawData) => {
        try {
          const message = JSON.parse(String(rawData));
          await handleSignalMessage({
            peerId,
            requestOrigin,
            message,
            emitSignal,
            closeSignal
          });
        } catch (error) {
          emitSignal({
            type: "rtc-error",
            payload: { message: error instanceof Error ? error.message : "rtc signaling parse error" }
          });
        }
      });
      signalSocket.on("close", () => {
        closePeer(peerId, "rtc signaling websocket closed");
      });
      signalSocket.on("error", () => {
        closePeer(peerId, "rtc signaling websocket error");
      });
    },
    async handleRelaySignal(peerId, requestOrigin, message, emitSignal, closeSignal) {
      await handleSignalMessage({
        peerId,
        requestOrigin,
        message,
        emitSignal,
        closeSignal: closeSignal || (() => void 0)
      });
    },
    closeRelayPeer(peerId, reason) {
      closePeer(peerId, reason);
    },
    dispose() {
      for (const peerId of peers.keys()) {
        closePeer(peerId, "rtc bridge disposed");
      }
    }
  };
}

// src/server/terminal-bridge-runtime.ts
function createTerminalBridgeRuntime(deps) {
  const connectionAttachChains = /* @__PURE__ */ new Map();
  const connectionInputChains = /* @__PURE__ */ new Map();
  const connectionMessageChains = /* @__PURE__ */ new Map();
  function decodeRawText(rawData) {
    return typeof rawData === "string" ? rawData : Buffer.isBuffer(rawData) ? rawData.toString("utf8") : Array.isArray(rawData) ? Buffer.concat(rawData).toString("utf8") : Buffer.from(rawData).toString("utf8");
  }
  function resolveMessageLane(rawData, isBinary) {
    if (isBinary) {
      return "message";
    }
    const text = decodeRawText(rawData);
    try {
      const parsed = JSON.parse(text);
      if (parsed.type === "input") {
        return "input";
      }
      if (parsed.type === "mux-channel-message" && typeof parsed.payload?.message?.type === "string") {
        return parsed.payload.message.type === "input" ? "input" : "message";
      }
      if (parsed.type === "session-open" || parsed.type === "connect" || parsed.type === "close") {
        return "attach";
      }
      if (parsed.type === "mux-channel-open" || parsed.type === "mux-channel-close") {
        return "attach";
      }
      if (parsed.type === "mux-channel-binary") {
        return "message";
      }
      return "message";
    } catch {
      return "input";
    }
  }
  function settleConnectionChain(chains, connectionId, chain) {
    chains.set(connectionId, chain);
    chain.finally(() => {
      if (chains.get(connectionId) === chain) {
        chains.delete(connectionId);
      }
    });
  }
  function enqueueConnectionMessage(connection, rawData, isBinary) {
    const attachPrevious = connectionAttachChains.get(connection.id) || Promise.resolve();
    const inputPrevious = connectionInputChains.get(connection.id) || Promise.resolve();
    const messagePrevious = connectionMessageChains.get(connection.id) || Promise.resolve();
    const lane = resolveMessageLane(rawData, isBinary);
    const previous = lane === "attach" ? Promise.all([attachPrevious, inputPrevious, messagePrevious]).then(() => void 0) : lane === "input" ? Promise.all([attachPrevious]).then(() => void 0) : Promise.all([attachPrevious, messagePrevious]).then(() => void 0);
    const next = previous.catch(() => void 0).then(() => deps.handleMessage(connection, rawData, isBinary)).catch((error) => {
      console.error(
        `[${deps.logTimePrefix()}] transport ${connection.id} message handling failed: ${error instanceof Error ? error.message : String(error)}`
      );
    });
    if (lane === "attach") {
      settleConnectionChain(connectionAttachChains, connection.id, next);
      return;
    }
    if (lane === "input") {
      const aggregate = Promise.all([
        inputPrevious.catch(() => void 0),
        next.catch(() => void 0)
      ]).then(() => void 0);
      settleConnectionChain(connectionInputChains, connection.id, aggregate);
      return;
    }
    settleConnectionChain(connectionMessageChains, connection.id, next);
  }
  function refreshBoundAdaptiveLease(connection) {
    const subscriberIds = /* @__PURE__ */ new Set();
    if (connection.boundSubscriberId) {
      subscriberIds.add(connection.boundSubscriberId);
    }
    for (const subscriberId of connection.muxChannels?.values() || []) {
      subscriberIds.add(subscriberId);
    }
    for (const subscriberId of subscriberIds) {
      const subscriber = deps.sessions.get(subscriberId) || null;
      if (!subscriber) {
        continue;
      }
      deps.refreshAdaptiveWidthLeaseHeartbeat(subscriber);
    }
  }
  function detachConnectionSubscribers(connection, reason) {
    const subscriberIds = /* @__PURE__ */ new Set();
    if (connection.boundSubscriberId) {
      subscriberIds.add(connection.boundSubscriberId);
    }
    for (const subscriberId of connection.muxChannels?.values() || []) {
      subscriberIds.add(subscriberId);
    }
    for (const subscriberId of subscriberIds) {
      const subscriber = deps.sessions.get(subscriberId) || null;
      if (!subscriber) {
        continue;
      }
      deps.detachSubscriberTransportOnly(subscriber, reason, connection.transportId);
    }
    connection.muxChannels?.clear();
  }
  const rtcBridgeServer2 = createRtcBridgeServer({
    onTransportOpen: (transport) => {
      const connection = deps.createTransportConnection(
        deps.createRtcSessionTransport(transport),
        transport.requestOrigin
      );
      console.log(`[${deps.logTimePrefix()}] rtc transport ${connection.id} created`);
      return {
        onMessage: (_transportId, data, isBinary) => {
          markTransportConnectionInboundActivity(connection);
          refreshBoundAdaptiveLease(connection);
          enqueueConnectionMessage(connection, data, isBinary);
        },
        onClose: (_transportId, reason) => {
          console.log(`[${deps.logTimePrefix()}] rtc transport ${connection.id} closed: ${reason}`);
          detachConnectionSubscribers(connection, reason);
          deps.connections.delete(connection.id);
        },
        onError: (_transportId, message) => {
          console.error(`[${deps.logTimePrefix()}] rtc transport ${connection.id} error: ${message}`);
          detachConnectionSubscribers(connection, `rtc error: ${message}`);
          deps.connections.delete(connection.id);
        }
      };
    }
  });
  function handleWebSocketConnection2(ws, request) {
    const providedToken = deps.extractAuthToken(request.url);
    if (deps.requiredAuthToken && providedToken !== deps.requiredAuthToken) {
      ws.send(JSON.stringify({ type: "error", payload: { message: "Unauthorized bridge token", code: "unauthorized" } }));
      ws.close(4001, "unauthorized");
      console.warn(`[${deps.logTimePrefix()}] unauthorized websocket from ${request.socket.remoteAddress || "unknown"}`);
      return;
    }
    const connection = deps.createTransportConnection(
      deps.createWebSocketSessionTransport(ws),
      deps.resolveRequestOrigin(request)
    );
    console.log(
      `[${deps.logTimePrefix()}] websocket transport ${connection.id} created origin=${connection.requestOrigin} role=${connection.role}`
    );
    ws.on("pong", () => {
      markTransportConnectionInboundActivity(connection);
      refreshBoundAdaptiveLease(connection);
    });
    ws.on("message", (rawData, isBinary) => {
      markTransportConnectionInboundActivity(connection);
      refreshBoundAdaptiveLease(connection);
      enqueueConnectionMessage(connection, rawData, isBinary);
    });
    ws.on("close", (code, rawReason) => {
      const reason = Buffer.isBuffer(rawReason) ? rawReason.toString("utf8") : String(rawReason || "");
      console.log(
        `[${deps.logTimePrefix()}] websocket transport ${connection.id} closed code=${code} reason=${reason || "n/a"} role=${connection.role} bound=${connection.boundSubscriberId || "none"}`
      );
      detachConnectionSubscribers(connection, "websocket closed");
      deps.connections.delete(connection.id);
    });
    ws.on("error", (error) => {
      console.error(`[${deps.logTimePrefix()}] websocket transport ${connection.id} error: ${error.message}`);
      detachConnectionSubscribers(connection, `websocket error: ${error.message}`);
      deps.connections.delete(connection.id);
    });
  }
  function handleServerUpgrade2(request, socket, head) {
    const origin = deps.resolveRequestOrigin(request);
    const pathname = new URL(request.url || "/", origin).pathname;
    if (pathname === "/signal") {
      deps.wss.handleUpgrade(request, socket, head, (ws) => {
        const providedToken = deps.extractAuthToken(request.url);
        if (deps.requiredAuthToken && providedToken !== deps.requiredAuthToken) {
          ws.send(JSON.stringify({ type: "rtc-error", payload: { message: "Unauthorized bridge token" } }));
          ws.close(4001, "unauthorized");
          return;
        }
        rtcBridgeServer2.handleSignalConnection(ws, origin);
      });
      return;
    }
    if (pathname !== "/" && pathname !== "/ws") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    deps.wss.handleUpgrade(request, socket, head, (ws) => {
      deps.wss.emit("connection", ws, request);
    });
  }
  async function handleRelaySignal2(peerId, message, emitSignal) {
    await rtcBridgeServer2.handleRelaySignal(peerId, "relay-host", message, emitSignal);
  }
  function closeRelayPeer2(peerId, reason) {
    rtcBridgeServer2.closeRelayPeer(peerId, reason);
  }
  return {
    rtcBridgeServer: rtcBridgeServer2,
    handleWebSocketConnection: handleWebSocketConnection2,
    handleServerUpgrade: handleServerUpgrade2,
    handleRelaySignal: handleRelaySignal2,
    closeRelayPeer: closeRelayPeer2
  };
}

// src/server/terminal-attach-token-runtime.ts
var import_crypto4 = __toESM(require("crypto"), 1);
function createTerminalAttachTokenRuntime() {
  const sessionTransportAttachTokens = /* @__PURE__ */ new Set();
  function issueSessionTransportToken() {
    const token = import_crypto4.default.randomUUID();
    sessionTransportAttachTokens.add(token);
    return token;
  }
  function consumeSessionTransportToken(token) {
    if (!sessionTransportAttachTokens.has(token)) {
      return false;
    }
    sessionTransportAttachTokens.delete(token);
    return true;
  }
  return {
    issueSessionTransportToken,
    consumeSessionTransportToken
  };
}

// src/server/remote-screenshot-daemon.ts
var import_node_child_process = require("node:child_process");
var import_node_os = require("node:os");
var import_node_path2 = require("node:path");
async function captureRemoteScreenshotWithDaemon(options) {
  return await new Promise((resolve4, reject) => {
    const daemonBinary = (process.env.ZTERM_DAEMON_NATIVE || "").trim() || (0, import_node_path2.join)((0, import_node_os.homedir)(), ".zterm", "bin", "zterm-daemon");
    const args = ["capture-screen", options.outputPath];
    const windowId = options.windowId?.trim();
    if (windowId) {
      args.push("--window-id", windowId);
    }
    if (options.rect) {
      args.push(
        "--rect",
        [
          Math.round(options.rect.x),
          Math.round(options.rect.y),
          Math.round(options.rect.width),
          Math.round(options.rect.height)
        ].join(",")
      );
    }
    (0, import_node_child_process.execFile)(daemonBinary, args, {
      timeout: options.timeoutMs,
      windowsHide: true
    }, (error, stdout, stderr) => {
      if (error) {
        const details = [error.message, stderr, stdout].filter(Boolean).join("\n");
        reject(new Error(details || "daemon screenshot capture failed"));
        return;
      }
      resolve4({ outputPath: options.outputPath });
    });
  });
}

// src/server/remote-window-stream-daemon.ts
var import_node_child_process2 = require("node:child_process");
var import_wrtc2 = __toESM(require_lib2(), 1);
var DEFAULT_ITERM2_PYTHON_TIMEOUT_MS = 5e3;
var DEFAULT_MACOS_APP_WINDOW_CATALOG_TIMEOUT_MS = 15e3;
var DEFAULT_SCREEN_CAPTURE_KIT_STARTUP_TIMEOUT_MS = 2e4;
var DEFAULT_REMOTE_WINDOW_FRAME_RATE = 30;
var DEFAULT_REMOTE_WINDOW_TARGET_CATALOG_CACHE_TTL_MS = 6e4;
var REMOTE_WINDOW_INPUT_STALE_MS = 1e3;
var REMOTE_WINDOW_INPUT_FOCUS_TIMEOUT_MS = 3e3;
var REMOTE_WINDOW_INPUT_HELPER_READY_TIMEOUT_MS = 15e3;
var ITERM2_APP_BUNDLE_ID = "com.googlecode.iterm2";
var ITERM2_PANE_GAP_PX = 1;
var REMOTE_WINDOW_ERROR_MESSAGE_MAX_CHARS = 220;
var REMOTE_WINDOW_CAPTURE_FRAME_MAGIC = Buffer.from("ZRW1");
var {
  RTCPeerConnection: RTCPeerConnection2,
  RTCSessionDescription: RTCSessionDescription2,
  RTCIceCandidate: RTCIceCandidate2,
  nonstandard
} = import_wrtc2.default;
function buildRemoteWindowImagePasteInputPayloads(options) {
  const now = options.now ?? Date.now;
  return [
    {
      requestId: `${options.requestPrefix}-0`,
      streamId: options.streamId,
      targetId: options.targetId,
      clientSentAt: now(),
      event: {
        kind: "key",
        phase: "down",
        key: "v",
        code: "KeyV",
        metaKey: true
      }
    },
    {
      requestId: `${options.requestPrefix}-1`,
      streamId: options.streamId,
      targetId: options.targetId,
      clientSentAt: now(),
      event: {
        kind: "key",
        phase: "up",
        key: "v",
        code: "KeyV",
        metaKey: true
      }
    }
  ];
}
var ITERM2_CATALOG_PYTHON = String.raw`
import json
import iterm2

def frame_dict(frame):
    return {
        "x": int(round(frame.origin.x)),
        "y": int(round(frame.origin.y)),
        "width": int(round(frame.size.width)),
        "height": int(round(frame.size.height)),
    }

async def node_dict(node):
    if hasattr(node, "session_id"):
        tty = None
        try:
            tty = await node.async_get_variable("session.tty")
        except Exception:
            tty = None
        grid = None
        try:
            grid = {"width": int(node.grid_size.width), "height": int(node.grid_size.height)}
        except Exception:
            grid = None
        return {
            "type": "session",
            "sessionId": node.session_id,
            "title": getattr(node, "name", "") or "",
            "tty": tty,
            "frame": frame_dict(node.frame),
            "gridSize": grid,
        }
    children = []
    for child in getattr(node, "children", []) or []:
        children.append(await node_dict(child))
    return {
        "type": "splitter",
        "vertical": bool(getattr(node, "vertical", False)),
        "children": children,
    }

async def main(connection):
    app = await iterm2.async_get_app(connection)
    windows = []
    for window in app.terminal_windows:
        frame = await window.async_get_frame()
        tabs = []
        for tab in window.tabs:
            try:
                await tab.async_update_layout()
            except Exception:
                pass
            root = await node_dict(tab.root) if tab.root else None
            tabs.append({
                "tabId": tab.tab_id,
                "activeSessionId": tab.active_session_id,
                "root": root,
            })
        windows.append({
            "windowId": getattr(window, "window_id", "") or "",
            "title": "iTerm2",
            "pid": 0,
            "frame": frame_dict(frame),
            "tabs": tabs,
        })
    print(json.dumps({"windows": windows}, ensure_ascii=False))

iterm2.run_until_complete(main)
`;
var MACOS_APP_WINDOW_CATALOG_SWIFT = String.raw`
import AppKit
import CoreGraphics
import Foundation

func number(_ value: Any?) -> Double? {
    if let number = value as? NSNumber {
        return number.doubleValue
    }
    return nil
}

func rectDict(_ rect: CGRect) -> [String: Any] {
    return [
        "x": Int(rect.origin.x.rounded()),
        "y": Int(rect.origin.y.rounded()),
        "width": Int(rect.size.width.rounded()),
        "height": Int(rect.size.height.rounded()),
    ]
}

func activeDisplays() -> [CGDirectDisplayID] {
    var count: UInt32 = 0
    CGGetActiveDisplayList(0, nil, &count)
    guard count > 0 else {
        return []
    }
    var displays = [CGDirectDisplayID](repeating: 0, count: Int(count))
    CGGetActiveDisplayList(count, &displays, &count)
    return Array(displays.prefix(Int(count)))
}

func intersectionArea(_ lhs: CGRect, _ rhs: CGRect) -> Double {
    let intersection = lhs.intersection(rhs)
    if intersection.isNull || intersection.isEmpty {
        return 0
    }
    return Double(max(0, intersection.width)) * Double(max(0, intersection.height))
}

func bestDisplay(for frame: CGRect) -> (id: CGDirectDisplayID, bounds: CGRect)? {
    var best: (id: CGDirectDisplayID, bounds: CGRect, area: Double)? = nil
    for displayId in activeDisplays() {
        let bounds = CGDisplayBounds(displayId)
        let area = intersectionArea(frame, bounds)
        guard area > 0 else {
            continue
        }
        if best == nil || area > best!.area {
            best = (displayId, bounds, area)
        }
    }
    return best.map { ($0.id, $0.bounds) }
}

let windowInfoList = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
var windows: [[String: Any]] = []

for info in windowInfoList {
    guard let layerValue = number(info[kCGWindowLayer as String]), Int(layerValue) == 0 else {
        continue
    }
    let alpha = number(info[kCGWindowAlpha as String]) ?? 1
    if alpha <= 0 {
        continue
    }
    guard
        let pidNumber = info[kCGWindowOwnerPID as String] as? NSNumber,
        let bounds = info[kCGWindowBounds as String] as? [String: Any],
        let x = number(bounds["X"]),
        let y = number(bounds["Y"]),
        let width = number(bounds["Width"]),
        let height = number(bounds["Height"])
    else {
        continue
    }
    if width < 40 || height < 40 {
        continue
    }
    let pid = pidNumber.intValue
    let ownerName = info[kCGWindowOwnerName as String] as? String ?? ""
    let rawTitle = info[kCGWindowName as String] as? String ?? ""
    let appBundleId = NSRunningApplication(processIdentifier: pid_t(pid))?.bundleIdentifier ?? ""
    let windowId = (info[kCGWindowNumber as String] as? NSNumber)?.stringValue ?? ""
    let title = rawTitle.isEmpty ? (ownerName.isEmpty ? appBundleId : ownerName) : rawTitle
    let frameRect = CGRect(x: x, y: y, width: width, height: height)
    var windowEntry: [String: Any] = [
        "windowId": windowId,
        "ownerName": ownerName,
        "appBundleId": appBundleId,
        "pid": pid,
        "title": title,
        "frame": rectDict(frameRect),
    ]
    if let display = bestDisplay(for: frameRect) {
        windowEntry["displayId"] = String(display.id)
        windowEntry["displayBoundsTopLeftPx"] = rectDict(display.bounds)
    }
    windows.append(windowEntry)
}

let data = try JSONSerialization.data(withJSONObject: ["windows": windows], options: [])
FileHandle.standardOutput.write(data)
`;
var MACOS_REMOTE_WINDOW_INPUT_SWIFT = String.raw`
import AppKit
import CoreGraphics
import Foundation

struct InputConfig: Decodable {
    let pid: Int32
    let appBundleId: String
    let focusPolicy: String
    let window: RemoteInputWindow
    let event: RemoteInputEvent
}

struct Rect: Decodable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct RemoteInputWindow: Decodable {
    let windowId: String
    let title: String
    let bounds: Rect
}

struct RemoteInputEvent: Decodable {
    let kind: String
    let gesture: String?
    let phase: String?
    let button: String?
    let buttons: Int?
    let pointerId: Int?
    let startX: Double?
    let startY: Double?
    let x: Double?
    let y: Double?
    let startNormalizedX: Double?
    let startNormalizedY: Double?
    let normalizedX: Double?
    let normalizedY: Double?
    let unit: String?
    let deltaX: Double?
    let deltaY: Double?
    let durationMs: Double?
    let velocityX: Double?
    let velocityY: Double?
    let key: String?
    let code: String?
    let text: String?
    let shiftKey: Bool?
    let altKey: Bool?
    let ctrlKey: Bool?
    let metaKey: Bool?
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(2)
}

func inputError(_ message: String, code: Int = 1) -> NSError {
    return NSError(domain: "RemoteWindowInput", code: code, userInfo: [NSLocalizedDescriptionKey: message])
}

func closeEnough(_ lhs: Double, _ rhs: Double, tolerance: Double = 8.0) -> Bool {
    return abs(lhs - rhs) <= tolerance
}

func copyAttribute(_ element: AXUIElement, _ attribute: String) -> AnyObject? {
    var value: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
    if result != .success {
        return nil
    }
    return value as AnyObject?
}

func rectScore(_ position: CGPoint, _ size: CGSize, _ bounds: Rect) -> Double {
    return abs(position.x - bounds.x)
        + abs(position.y - bounds.y)
        + abs(size.width - bounds.width)
        + abs(size.height - bounds.height)
}

func axPoint(_ value: AnyObject?) -> CGPoint? {
    guard let value = value else { return nil }
    let axValue = value as! AXValue
    var point = CGPoint.zero
    if AXValueGetType(axValue) != .cgPoint {
        return nil
    }
    AXValueGetValue(axValue, .cgPoint, &point)
    return point
}

func axSize(_ value: AnyObject?) -> CGSize? {
    guard let value = value else { return nil }
    let axValue = value as! AXValue
    var size = CGSize.zero
    if AXValueGetType(axValue) != .cgSize {
        return nil
    }
    AXValueGetValue(axValue, .cgSize, &size)
    return size
}

func frontmostPidMatches(_ pid: Int32) -> Bool {
    guard let frontmost = NSWorkspace.shared.frontmostApplication else {
        return false
    }
    return frontmost.processIdentifier == pid
}

func waitForRunningApplication(_ pid: Int32) -> NSRunningApplication? {
    for attempt in 0..<6 {
        if let app = NSRunningApplication(processIdentifier: pid) {
            return app
        }
        if attempt < 5 {
            usleep(50000)
        }
    }
    return nil
}

func axWindowMatchesBounds(_ window: AXUIElement, _ bounds: Rect) -> Bool {
    guard
        let position = axPoint(copyAttribute(window, kAXPositionAttribute)),
        let size = axSize(copyAttribute(window, kAXSizeAttribute))
    else {
        return false
    }
    return rectScore(position, size, bounds) <= 96.0
}

func focusedWindowMatchesTarget(_ appElement: AXUIElement, _ bounds: Rect) -> Bool {
    guard let focusedWindow = copyAttribute(appElement, kAXFocusedWindowAttribute) else {
        return false
    }
    let focusedElement = focusedWindow as! AXUIElement
    return axWindowMatchesBounds(focusedElement, bounds)
}

func activateTargetApplication(_ config: InputConfig, _ app: NSRunningApplication) {
    app.unhide()
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
    process.arguments = [
        "-e",
        "tell application \"System Events\" to set frontmost of first process whose unix id is " + String(config.pid) + " to true"
    ]
    try? process.run()
    process.waitUntilExit()
}

func focusTargetWindow(_ config: InputConfig) throws {
    guard config.focusPolicy == "bring-to-focus" else {
        return
    }
    guard AXIsProcessTrusted() else {
        throw NSError(domain: "RemoteWindowInput", code: 2, userInfo: [NSLocalizedDescriptionKey: "macOS Accessibility permission is required for remote window input"])
    }
    guard let app = waitForRunningApplication(config.pid) else {
        throw NSError(domain: "RemoteWindowInput", code: 3, userInfo: [NSLocalizedDescriptionKey: "remote input target app is not running pid=" + String(config.pid)])
    }
    let appElement = AXUIElementCreateApplication(config.pid)
    if frontmostPidMatches(config.pid) && focusedWindowMatchesTarget(appElement, config.window.bounds) {
        return
    }
    let windows = copyAttribute(appElement, kAXWindowsAttribute) as? [AXUIElement] ?? []
    var bestWindow: AXUIElement?
    var bestScore = Double.greatestFiniteMagnitude
    for window in windows {
        guard
            let position = axPoint(copyAttribute(window, kAXPositionAttribute)),
            let size = axSize(copyAttribute(window, kAXSizeAttribute))
        else {
            continue
        }
        let score = rectScore(position, size, config.window.bounds)
        if score < bestScore {
            bestScore = score
            bestWindow = window
        }
    }
    guard let window = bestWindow, bestScore <= 96.0 else {
        throw NSError(domain: "RemoteWindowInput", code: 4, userInfo: [NSLocalizedDescriptionKey: "remote input target window could not be matched for focus"])
    }
	    var isFrontmost = false
	    var isFocused = false
	    for attempt in 0..<3 {
	        activateTargetApplication(config, app)
	        AXUIElementSetAttributeValue(appElement, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
	        AXUIElementPerformAction(window, kAXRaiseAction as CFString)
	        AXUIElementSetAttributeValue(appElement, kAXFocusedWindowAttribute as CFString, window)
	        AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
	        AXUIElementSetAttributeValue(window, kAXFocusedAttribute as CFString, kCFBooleanTrue)
	        AXUIElementSetAttributeValue(appElement, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
	        usleep(attempt == 0 ? 120000 : 180000)
        isFrontmost = frontmostPidMatches(config.pid)
        isFocused = focusedWindowMatchesTarget(appElement, config.window.bounds)
        if isFrontmost && isFocused {
            return
        }
    }
    if !isFrontmost {
        throw NSError(domain: "RemoteWindowInput", code: 5, userInfo: [NSLocalizedDescriptionKey: "remote input target app did not become frontmost"])
    }
    if !isFocused {
        throw NSError(domain: "RemoteWindowInput", code: 6, userInfo: [NSLocalizedDescriptionKey: "remote input target window did not become focused"])
    }
}

let source = CGEventSource(stateID: .hidSystemState)

func flags(_ event: RemoteInputEvent) -> CGEventFlags {
    var result = CGEventFlags()
    if event.shiftKey == true { result.insert(.maskShift) }
    if event.altKey == true { result.insert(.maskAlternate) }
    if event.ctrlKey == true { result.insert(.maskControl) }
    if event.metaKey == true { result.insert(.maskCommand) }
    return result
}

func mouseButton(_ button: String?) -> CGMouseButton {
    switch button {
    case "right": return .right
    case "middle": return .center
    default: return .left
    }
}

func mouseType(phase: String, button: String?, buttons: Int?) -> CGEventType {
    let right = button == "right"
    let middle = button == "middle"
    if phase == "down" { return right ? .rightMouseDown : .leftMouseDown }
    if phase == "up" { return right ? .rightMouseUp : .leftMouseUp }
    if phase == "move" && (buttons ?? 0) > 0 {
        if right { return .rightMouseDragged }
        if middle { return .otherMouseDragged }
        return .leftMouseDragged
    }
    return .mouseMoved
}

func postMouseMove(x: Double, y: Double) {
    let point = CGPoint(x: x, y: y)
    let event = CGEvent(
        mouseEventSource: source,
        mouseType: .mouseMoved,
        mouseCursorPosition: point,
        mouseButton: .left
    )
    event?.post(tap: .cghidEventTap)
}

func postScrollEvent(x: Double, y: Double, deltaX: Double, deltaY: Double, unit: String?) {
    let units: CGScrollEventUnit = unit == "pixel" ? .pixel : .line
    let point = CGPoint(x: x, y: y)
    postMouseMove(x: x, y: y)
    // Android/DOM deltas use positive values for scrolling down/right; CGEvent
    // wheel values use the opposite sign for pixel scroll injection.
    let wheel1 = Int32(max(-32767, min(32767, (-deltaY).rounded())))
    let wheel2 = Int32(max(-32767, min(32767, (-deltaX).rounded())))
    let event = CGEvent(
        scrollWheelEvent2Source: source,
        units: units,
        wheelCount: 2,
        wheel1: wheel1,
        wheel2: wheel2,
        wheel3: 0
    )
    event?.location = point
    event?.post(tap: .cghidEventTap)
}

let keyCodes: [String: CGKeyCode] = [
    "Enter": 36,
    "NumpadEnter": 76,
    "Escape": 53,
    "Backspace": 51,
    "Tab": 48,
    "Space": 49,
    "ArrowLeft": 123,
    "ArrowRight": 124,
    "ArrowDown": 125,
    "ArrowUp": 126,
    "KeyV": 9,
    "Delete": 117,
    "Home": 115,
    "End": 119,
    "PageUp": 116,
    "PageDown": 121,
]

func handleConfig(_ config: InputConfig) throws {
    try focusTargetWindow(config)

    if config.event.kind == "focus" {
        return
    } else if config.event.kind == "pointer" {
        guard let phase = config.event.phase else {
            throw inputError("remote pointer input missing phase")
        }
        guard let x = config.event.x, let y = config.event.y else {
            throw inputError("remote pointer input missing coordinates")
        }
        let point = CGPoint(x: x, y: y)
        let event = CGEvent(
            mouseEventSource: source,
            mouseType: mouseType(phase: phase, button: config.event.button, buttons: config.event.buttons),
            mouseCursorPosition: point,
            mouseButton: mouseButton(config.event.button)
        )
        event?.post(tap: .cghidEventTap)
    } else if config.event.kind == "scroll" {
        guard
            let x = config.event.x,
            let y = config.event.y,
            let deltaX = config.event.deltaX,
            let deltaY = config.event.deltaY
        else {
            throw inputError("remote scroll input missing delta or coordinates")
        }
        postScrollEvent(x: x, y: y, deltaX: deltaX, deltaY: deltaY, unit: config.event.unit)
    } else if config.event.kind == "gesture" {
        guard config.event.gesture == "swipe", config.event.phase == "end" else {
            throw inputError("remote gesture input unsupported")
        }
        guard
            let startX = config.event.startX,
            let startY = config.event.startY,
            let x = config.event.x,
            let y = config.event.y,
            let deltaX = config.event.deltaX,
            let deltaY = config.event.deltaY
        else {
            throw inputError("remote gesture input missing delta or coordinates")
        }
        _ = x
        _ = y
        postScrollEvent(x: startX, y: startY, deltaX: deltaX, deltaY: deltaY, unit: config.event.unit)
    } else if config.event.kind == "key" {
        guard let phase = config.event.phase else {
            throw inputError("remote key input missing phase")
        }
        let down = phase == "down"
        let code = config.event.code ?? ""
        if let keyCode = keyCodes[code] {
            let event = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: down)
            event?.flags = flags(config.event)
            event?.post(tap: .cghidEventTap)
        } else if !(config.event.text ?? config.event.key ?? "").isEmpty {
            var utf16 = (config.event.text ?? config.event.key ?? "").utf16.map { UniChar($0) }
            let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
            event?.flags = flags(config.event)
            event?.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
            event?.post(tap: .cghidEventTap)
        } else {
            throw inputError("remote key input unsupported: \(code)")
        }
    } else {
        throw inputError("remote input event kind unsupported")
    }
}

func writeResult(ok: Bool, error: String? = nil) {
    var result: [String: Any] = ["ok": ok]
    if let error = error {
        result["error"] = error
    }
    if let data = try? JSONSerialization.data(withJSONObject: result, options: []) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write("\n".data(using: .utf8)!)
    }
}

@discardableResult
func handleRawConfig(_ rawConfig: String, exitOnFailure: Bool) -> Bool {
    do {
        guard let data = rawConfig.data(using: .utf8) else {
            throw inputError("remote input config is not utf8")
        }
        let config = try JSONDecoder().decode(InputConfig.self, from: data)
        try handleConfig(config)
        writeResult(ok: true)
        return true
    } catch {
        writeResult(ok: false, error: error.localizedDescription)
        if exitOnFailure {
            exit(2)
        }
        return false
    }
}

func writeReady() {
    print("{\"ready\":true}")
    fflush(stdout)
}

if let rawConfig = ProcessInfo.processInfo.environment["ZTERM_REMOTE_WINDOW_INPUT_CONFIG"] {
    handleRawConfig(rawConfig, exitOnFailure: true)
} else {
    writeReady()
    while let line = readLine(strippingNewline: true) {
        if line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            continue
        }
        handleRawConfig(line, exitOnFailure: false)
    }
}
`;
var SCREEN_CAPTURE_KIT_FRAME_SOURCE_SWIFT = String.raw`
import AppKit
import CoreGraphics
import CoreMedia
import Foundation
import ScreenCaptureKit

struct CaptureConfig: Decodable {
    let windowId: String
    let appBundleId: String
    let title: String
    let windowBounds: Rect
    let cropRect: Rect
    let frameRate: Int
    let queueDepth: Int
}

struct Rect: Decodable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

func stderrLine(_ message: String) {
    if let data = (message + "\n").data(using: .utf8) {
        FileHandle.standardError.write(data)
    }
}

func appendUInt32(_ value: UInt32, to data: inout Data) {
    var littleEndian = value.littleEndian
    withUnsafeBytes(of: &littleEndian) { bytes in
        data.append(contentsOf: bytes)
    }
}

func closeEnough(_ lhs: Double, _ rhs: Double) -> Bool {
    return abs(lhs - rhs) <= 4.0
}

func rectMatches(_ frame: CGRect, _ rect: Rect) -> Bool {
    return closeEnough(frame.origin.x, rect.x)
        && closeEnough(frame.origin.y, rect.y)
        && closeEnough(frame.size.width, rect.width)
        && closeEnough(frame.size.height, rect.height)
}

final class FrameOutput: NSObject, SCStreamOutput {
    private var emitted = 0

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen else {
            return
        }
        guard sampleBuffer.isValid, let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else {
            return
        }

        CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }

        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
        guard width > 0, height > 0, let baseAddress = CVPixelBufferGetBaseAddress(pixelBuffer) else {
            return
        }

        let source = baseAddress.assumingMemoryBound(to: UInt8.self)
        var rgba = Data(count: width * height * 4)
        rgba.withUnsafeMutableBytes { destinationRaw in
            guard let destinationBase = destinationRaw.baseAddress?.assumingMemoryBound(to: UInt8.self) else {
                return
            }
            for y in 0..<height {
                let sourceRow = source.advanced(by: y * bytesPerRow)
                let destinationRow = destinationBase.advanced(by: y * width * 4)
                for x in 0..<width {
                    let sourcePixel = sourceRow.advanced(by: x * 4)
                    let destinationPixel = destinationRow.advanced(by: x * 4)
                    destinationPixel[0] = sourcePixel[2]
                    destinationPixel[1] = sourcePixel[1]
                    destinationPixel[2] = sourcePixel[0]
                    destinationPixel[3] = sourcePixel[3]
                }
            }
        }

        var header = Data()
        header.append(contentsOf: [0x5A, 0x52, 0x57, 0x31])
        appendUInt32(UInt32(width), to: &header)
        appendUInt32(UInt32(height), to: &header)
        appendUInt32(UInt32(rgba.count), to: &header)
        FileHandle.standardOutput.write(header)
        FileHandle.standardOutput.write(rgba)
        emitted += 1
    }
}

let env = ProcessInfo.processInfo.environment
guard let configJson = env["ZTERM_REMOTE_WINDOW_CAPTURE_CONFIG"],
      let configData = configJson.data(using: .utf8) else {
    stderrLine("missing ZTERM_REMOTE_WINDOW_CAPTURE_CONFIG")
    exit(2)
}

let config: CaptureConfig
do {
    config = try JSONDecoder().decode(CaptureConfig.self, from: configData)
} catch {
    stderrLine("invalid capture config: " + String(describing: error))
    exit(2)
}

NSApplication.shared
let output = FrameOutput()
let sampleQueue = DispatchQueue(label: "zterm.remote-window.capture.sample")
var activeStream: SCStream?

Task { @MainActor in
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let numericWindowId = UInt32(config.windowId)
        let window = content.windows.first { candidate in
            if let numericWindowId = numericWindowId, candidate.windowID == numericWindowId {
                return true
            }
            if !config.appBundleId.isEmpty && candidate.owningApplication?.bundleIdentifier != config.appBundleId {
                return false
            }
            return rectMatches(candidate.frame, config.windowBounds)
        }
        guard let targetWindow = window else {
            stderrLine("ScreenCaptureKit window not found for " + config.windowId)
            exit(3)
        }

        let filter = SCContentFilter(desktopIndependentWindow: targetWindow)
        let streamConfiguration = SCStreamConfiguration()
        streamConfiguration.capturesAudio = false
        streamConfiguration.pixelFormat = kCVPixelFormatType_32BGRA
        streamConfiguration.queueDepth = max(1, min(1, config.queueDepth))
        streamConfiguration.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(max(1, config.frameRate)))
        streamConfiguration.width = max(1, Int(config.cropRect.width.rounded()))
        streamConfiguration.height = max(1, Int(config.cropRect.height.rounded()))
        streamConfiguration.sourceRect = CGRect(
            x: max(0, config.cropRect.x - config.windowBounds.x),
            y: max(0, config.cropRect.y - config.windowBounds.y),
            width: max(1, config.cropRect.width),
            height: max(1, config.cropRect.height)
        )

        let stream = SCStream(filter: filter, configuration: streamConfiguration, delegate: nil)
        activeStream = stream
        try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: sampleQueue)
        try await stream.startCapture()
        stderrLine("zterm remote window capture started")
    } catch {
        stderrLine("ScreenCaptureKit capture start failed: " + String(describing: error))
        exit(4)
    }
}

dispatchMain()
`;
function remoteWindowError(payload, code, message) {
  return {
    requestId: payload.requestId || "",
    code,
    message
  };
}
function buildRemoteWindowTargetCatalogCacheKey(payload) {
  return [
    payload.includeAppWindows !== false ? "app" : "no-app",
    payload.includeIterm2 !== false ? "iterm2" : "no-iterm2"
  ].join("|");
}
function cloneRemoteWindowTargetCatalogResponse(response, requestId) {
  return {
    requestId,
    targets: response.targets.slice(),
    ...response.errors ? {
      errors: response.errors.map((error) => ({
        ...error,
        requestId
      }))
    } : {}
  };
}
function cloneRemoteWindowTargetCatalogResult(result, requestId) {
  if ("targets" in result) {
    return cloneRemoteWindowTargetCatalogResponse(result, requestId);
  }
  return {
    ...result,
    requestId
  };
}
function normalizeWhitespace(value) {
  return value.replace(/\s+/g, " ").trim();
}
function truncateRemoteWindowErrorMessage(message) {
  const normalized = normalizeWhitespace(message);
  if (normalized.length <= REMOTE_WINDOW_ERROR_MESSAGE_MAX_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, REMOTE_WINDOW_ERROR_MESSAGE_MAX_CHARS - 1).trimEnd()}...`;
}
function isExecFileTimeoutError(error) {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error;
  return candidate.killed === true || candidate.signal === "SIGTERM" || candidate.code === "ETIMEDOUT" || /timed out|timeout/iu.test(candidate.message || "");
}
function formatInlineScriptExecFailure(error, stdout, stderr, timeoutMs, timeoutMessage, fallbackMessage) {
  const timeoutDetail = isExecFileTimeoutError(error) ? `${timeoutMessage} after ${timeoutMs}ms` : "";
  return [stderr, stdout, timeoutDetail, error.message && !error.message.includes(" -c ") && !error.message.includes(" -e ") ? error.message : ""].filter(Boolean).join("\n") || fallbackMessage;
}
function buildScreenCaptureKitStartupTimeoutMessage(stderrBuffer, timeoutMs) {
  const stderrDetail = stderrBuffer.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).slice(-3).join(" ");
  return stderrDetail ? `ScreenCaptureKit capture did not produce a frame before timeout after ${timeoutMs}ms: ${stderrDetail}` : `ScreenCaptureKit capture did not produce a frame before timeout after ${timeoutMs}ms`;
}
function summarizeRemoteWindowCatalogError(error, fallbackMessage) {
  const raw = error instanceof Error ? error.message : String(error);
  const normalizedRaw = normalizeWhitespace(raw);
  const missingPythonModule = normalizedRaw.match(/No module named ['"]?([A-Za-z0-9_.-]+)['"]?/u);
  if (missingPythonModule?.[1]) {
    return `iTerm2 Python API unavailable: missing Python module ${missingPythonModule[1]}`;
  }
  const candidateLines = raw.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).filter((line) => !line.startsWith("Command failed:"));
  const diagnosticLine = [...candidateLines].reverse().find(
    (line) => /(?:error|exception|denied|permission|timeout|timed out|not found|unavailable|failed)/iu.test(line)
  ) || candidateLines[0] || normalizedRaw || fallbackMessage;
  return truncateRemoteWindowErrorMessage(diagnosticLine || fallbackMessage);
}
function validateRect(rect, label) {
  for (const key of ["x", "y", "width", "height"]) {
    const value = rect[key];
    if (!Number.isFinite(value)) {
      throw new Error(`${label}.${key} must be finite`);
    }
  }
  if (rect.width < 0 || rect.height < 0) {
    throw new Error(`${label} dimensions must be non-negative`);
  }
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height
  };
}
function rectWithOffset(rect, offset) {
  return {
    x: offset.x + rect.x,
    y: offset.y + rect.y,
    width: rect.width,
    height: rect.height
  };
}
function measureIterm2Node(node) {
  if (node.type === "session") {
    const frame = validateRect(node.frame, `session:${node.sessionId}`);
    return {
      width: frame.x + frame.width,
      height: frame.y + frame.height
    };
  }
  if (node.children.length === 0) {
    return { width: 0, height: 0 };
  }
  let cursor = 0;
  let width = 0;
  let height = 0;
  for (const child of node.children) {
    if (child.type === "session") {
      const frame = validateRect(child.frame, `session:${child.sessionId}`);
      width = Math.max(width, frame.x + frame.width);
      height = Math.max(height, frame.y + frame.height);
      cursor = Math.max(
        cursor,
        node.vertical ? frame.x + frame.width : frame.y + frame.height
      ) + ITERM2_PANE_GAP_PX;
      continue;
    }
    const childSize = measureIterm2Node(child);
    const childOffset = node.vertical ? { x: cursor, y: 0 } : { x: 0, y: cursor };
    width = Math.max(width, childOffset.x + childSize.width);
    height = Math.max(height, childOffset.y + childSize.height);
    cursor += (node.vertical ? childSize.width : childSize.height) + ITERM2_PANE_GAP_PX;
  }
  return { width, height };
}
function flattenIterm2SplitTree(node, origin = { x: 0, y: 0 }) {
  if (!node) {
    return [];
  }
  if (node.type === "session") {
    return [{
      sessionId: node.sessionId,
      title: node.title,
      tty: node.tty || null,
      frame: rectWithOffset(validateRect(node.frame, `session:${node.sessionId}`), origin),
      gridSize: node.gridSize
    }];
  }
  const panes = [];
  let cursor = 0;
  for (const child of node.children) {
    if (child.type === "session") {
      panes.push(...flattenIterm2SplitTree(child, origin));
      const childFrame = validateRect(child.frame, `session:${child.sessionId}`);
      cursor = Math.max(
        cursor,
        node.vertical ? childFrame.x + childFrame.width : childFrame.y + childFrame.height
      ) + ITERM2_PANE_GAP_PX;
      continue;
    }
    const childSize = measureIterm2Node(child);
    const childOrigin = node.vertical ? { x: origin.x + cursor, y: origin.y } : { x: origin.x, y: origin.y + cursor };
    panes.push(...flattenIterm2SplitTree(child, childOrigin));
    cursor += (node.vertical ? childSize.width : childSize.height) + ITERM2_PANE_GAP_PX;
  }
  return panes;
}
function parseTmuxClientTargets(stdout) {
  const targets = /* @__PURE__ */ new Map();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const [tty, tmuxSession, tmuxWindowId, tmuxPaneId] = trimmed.split("	");
    if (!tty || !tmuxSession) {
      continue;
    }
    targets.set(tty, {
      tty,
      tmuxSession,
      tmuxWindowId: tmuxWindowId || void 0,
      tmuxPaneId: tmuxPaneId || void 0
    });
  }
  return targets;
}
function computeContentBounds(panes) {
  return panes.reduce(
    (bounds, pane) => ({
      width: Math.max(bounds.width, pane.frame.x + pane.frame.width),
      height: Math.max(bounds.height, pane.frame.y + pane.frame.height)
    }),
    { width: 0, height: 0 }
  );
}
function assertPaneCropWithinWindow(windowFrame, cropRect, label) {
  const relativeLeft = cropRect.x - windowFrame.x;
  const relativeTop = cropRect.y - windowFrame.y;
  const relativeRight = relativeLeft + cropRect.width;
  const relativeBottom = relativeTop + cropRect.height;
  if (relativeLeft < 0 || relativeTop < 0 || relativeRight > windowFrame.width || relativeBottom > windowFrame.height) {
    throw new Error(`${label} crop rectangle is outside its window bounds`);
  }
}
function buildRemoteWindowStreamTargets(catalog, tmuxTargets, now, options = {}) {
  const targets = [];
  const includeAppWindowTargets = options.includeAppWindowTargets !== false;
  const appWindows = options.macosAppWindowCatalog?.windows || [];
  const requireCaptureWindowForPanes = options.requireCaptureWindowForPanes === true;
  let iTermPaneCount = 0;
  let skippedPaneCount = 0;
  for (const window of catalog.windows) {
    const itermWindowFrame = validateRect(window.frame, `window:${window.windowId}`);
    const captureWindow = findMatchingIterm2CaptureWindow(window, appWindows);
    const captureWindowFrame = captureWindow ? validateRect(captureWindow.frame, `app-window:${captureWindow.windowId}`) : itermWindowFrame;
    if (includeAppWindowTargets && (!requireCaptureWindowForPanes || captureWindow)) {
      targets.push({
        streamTargetId: captureWindow ? `app-window:${captureWindow.pid}:${captureWindow.windowId}` : `app-window:${window.windowId}`,
        videoTarget: {
          kind: "app-window",
          appBundleId: ITERM2_APP_BUNDLE_ID,
          pid: captureWindow?.pid ?? window.pid ?? 0,
          windowId: captureWindow?.windowId ?? window.windowId,
          title: captureWindow?.title || window.title || "iTerm2",
          windowBoundsTopLeftPx: captureWindowFrame,
          cropRectTopLeftPx: captureWindowFrame
        },
        inputTarget: {
          kind: "app-window"
        },
        streamMode: "interactive",
        focusPolicy: "bring-to-focus",
        inputRoute: "os-event",
        capture: {
          source: "ScreenCaptureKit",
          coordinateSpace: "macos-top-left-px",
          scale: 1,
          createdAt: now
        }
      });
    }
    if (requireCaptureWindowForPanes && !captureWindow) {
      for (const tab of window.tabs) {
        skippedPaneCount += flattenIterm2SplitTree(tab.root).length;
      }
      continue;
    }
    for (const tab of window.tabs) {
      const panes = flattenIterm2SplitTree(tab.root);
      iTermPaneCount += panes.length;
      const contentBounds = computeContentBounds(panes);
      if (contentBounds.width > captureWindowFrame.width || contentBounds.height > captureWindowFrame.height) {
        throw new Error(`window:${window.windowId}:tab:${tab.tabId} content bounds exceed window bounds`);
      }
      const contentTopInsetPx = captureWindowFrame.height - contentBounds.height;
      for (const pane of panes) {
        const tmuxTarget = pane.tty ? tmuxTargets.get(pane.tty) : void 0;
        const cropRectTopLeftPx = {
          x: captureWindowFrame.x + pane.frame.x,
          y: captureWindowFrame.y + contentTopInsetPx + pane.frame.y,
          width: pane.frame.width,
          height: pane.frame.height
        };
        assertPaneCropWithinWindow(
          captureWindowFrame,
          cropRectTopLeftPx,
          `window:${window.windowId}:tab:${tab.tabId}:pane:${pane.sessionId}`
        );
        targets.push({
          streamTargetId: `iterm2-pane:${window.windowId}:${tab.tabId}:${pane.sessionId}`,
          videoTarget: {
            kind: "iterm2-pane",
            appBundleId: ITERM2_APP_BUNDLE_ID,
            pid: captureWindow?.pid ?? window.pid ?? 0,
            windowId: captureWindow?.windowId ?? window.windowId,
            title: pane.title || window.title || "iTerm2 pane",
            windowBoundsTopLeftPx: captureWindowFrame,
            paneRectInContentPx: pane.frame,
            cropRectTopLeftPx,
            contentTopInsetPx
          },
          inputTarget: tmuxTarget ? {
            kind: "tmux-pane",
            itermSessionId: pane.sessionId,
            tty: pane.tty || void 0,
            tmuxSession: tmuxTarget.tmuxSession,
            tmuxWindowId: tmuxTarget.tmuxWindowId,
            tmuxPaneId: tmuxTarget.tmuxPaneId
          } : {
            kind: "iterm2-pane",
            itermSessionId: pane.sessionId,
            tty: pane.tty || void 0
          },
          streamMode: "view",
          focusPolicy: tmuxTarget ? "no-focus-steal" : "bring-to-focus",
          inputRoute: tmuxTarget ? "tmux-input" : "iterm2-api",
          capture: {
            source: "ScreenCaptureKit",
            coordinateSpace: "macos-top-left-px",
            ...captureWindow?.displayId ? { displayId: captureWindow.displayId } : {},
            ...captureWindow?.displayBoundsTopLeftPx ? { displayBoundsTopLeftPx: captureWindow.displayBoundsTopLeftPx } : {},
            scale: 1,
            createdAt: now
          }
        });
      }
    }
  }
  if (requireCaptureWindowForPanes && iTermPaneCount === 0 && skippedPaneCount > 0) {
    throw new Error("iTerm2 ScreenCaptureKit window id unavailable for all panes");
  }
  return targets;
}
function findMatchingIterm2CaptureWindow(window, appWindows) {
  const itermWindowFrame = validateRect(window.frame, `window:${window.windowId}`);
  let best = null;
  for (const candidate of appWindows) {
    if (candidate.appBundleId !== ITERM2_APP_BUNDLE_ID) {
      continue;
    }
    const frame = validateRect(candidate.frame, `app-window:${candidate.windowId}`);
    const geometryScore = Math.abs(frame.x - itermWindowFrame.x) + Math.abs(frame.width - itermWindowFrame.width) + Math.abs(frame.height - itermWindowFrame.height);
    if (geometryScore > 48) {
      continue;
    }
    const score = geometryScore + Math.min(48, Math.abs(frame.y - itermWindowFrame.y));
    if (!best || score < best.score) {
      best = { window: candidate, score };
    }
  }
  return best?.window || null;
}
function buildMacosAppWindowTargets(catalog, now) {
  return catalog.windows.map((window) => {
    const windowFrame = validateRect(window.frame, `app-window:${window.windowId}`);
    return {
      streamTargetId: `app-window:${window.pid}:${window.windowId}`,
      videoTarget: {
        kind: "app-window",
        appBundleId: window.appBundleId,
        pid: window.pid,
        windowId: window.windowId,
        title: window.title || window.ownerName || window.appBundleId || `Window ${window.windowId}`,
        windowBoundsTopLeftPx: windowFrame,
        cropRectTopLeftPx: windowFrame
      },
      inputTarget: {
        kind: "app-window"
      },
      streamMode: "interactive",
      focusPolicy: "bring-to-focus",
      inputRoute: "os-event",
      capture: {
        source: "ScreenCaptureKit",
        coordinateSpace: "macos-top-left-px",
        ...window.displayId ? { displayId: window.displayId } : {},
        ...window.displayBoundsTopLeftPx ? { displayBoundsTopLeftPx: window.displayBoundsTopLeftPx } : {},
        scale: 1,
        createdAt: now
      }
    };
  });
}
function runDefaultIterm2Python(script, options) {
  return new Promise((resolve4, reject) => {
    (0, import_node_child_process2.execFile)(options.pythonBinary, ["-c", script], {
      timeout: options.timeoutMs,
      windowsHide: true
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(formatInlineScriptExecFailure(
          error,
          stdout,
          stderr,
          options.timeoutMs,
          "iTerm2 Python catalog timed out",
          "iTerm2 Python API failed"
        )));
        return;
      }
      resolve4(stdout);
    });
  });
}
function runDefaultMacosAppWindowCatalog(script, options) {
  return new Promise((resolve4, reject) => {
    (0, import_node_child_process2.execFile)(options.swiftBinary, ["-e", script], {
      timeout: options.timeoutMs,
      windowsHide: true
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(formatInlineScriptExecFailure(
          error,
          stdout,
          stderr,
          options.timeoutMs,
          "macOS app window catalog timed out",
          "macOS app window catalog failed"
        )));
        return;
      }
      resolve4(stdout);
    });
  });
}
function isRemoteWindowFocusInputConfig(config) {
  return config.event.kind === "focus";
}
function resolveRemoteWindowInputHelperTimeoutMs(config) {
  return isRemoteWindowFocusInputConfig(config) ? REMOTE_WINDOW_INPUT_FOCUS_TIMEOUT_MS : REMOTE_WINDOW_INPUT_STALE_MS;
}
function remoteWindowInputConfigsShareTarget(lhs, rhs) {
  return lhs.pid === rhs.pid && lhs.appBundleId === rhs.appBundleId && lhs.focusPolicy === rhs.focusPolicy && lhs.window.windowId === rhs.window.windowId;
}
function shouldRefreshRemoteWindowQueuedInputAfterFocus(focusConfig, queuedConfig) {
  return isRemoteWindowFocusInputConfig(focusConfig) && !isRemoteWindowFocusInputConfig(queuedConfig) && remoteWindowInputConfigsShareTarget(focusConfig, queuedConfig);
}
function createDefaultRemoteWindowInputHelper(options) {
  let child = null;
  let stdoutBuffer = "";
  let stderrBuffer = "";
  let active = null;
  const queue = [];
  const warmWaiters = [];
  let disposed = false;
  let ready = false;
  let waitingForReadyPump = false;
  const stderrSummary = () => stderrBuffer.trim().slice(-REMOTE_WINDOW_ERROR_MESSAGE_MAX_CHARS);
  const rejectWarmWaiters = (error) => {
    while (warmWaiters.length > 0) {
      const waiter = warmWaiters.shift();
      if (!waiter) {
        continue;
      }
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
  };
  const resolveWarmWaiters = () => {
    while (warmWaiters.length > 0) {
      const waiter = warmWaiters.shift();
      if (!waiter) {
        continue;
      }
      clearTimeout(waiter.timeout);
      waiter.resolve();
    }
  };
  const rejectIfStale = (request) => {
    if (isRemoteWindowInputConfigStale(
      request.config,
      Date.now(),
      resolveRemoteWindowInputHelperTimeoutMs(request.config)
    )) {
      rejectRequest(request, new Error("remote window input stale"));
      return true;
    }
    return false;
  };
  const rejectRequest = (request, error) => {
    if (!request) {
      return;
    }
    if (request.timeout) {
      clearTimeout(request.timeout);
      request.timeout = null;
    }
    request.reject(error);
  };
  const rejectAll = (error) => {
    rejectRequest(active, error);
    active = null;
    while (queue.length > 0) {
      rejectRequest(queue.shift() || null, error);
    }
  };
  const refreshQueueAfterSuccessfulFocus = (focusConfig) => {
    if (!isRemoteWindowFocusInputConfig(focusConfig)) {
      return;
    }
    const receivedAtMs = Date.now();
    for (const request of queue) {
      if (request.refreshReceivedAtAfterFocusConfig === focusConfig && shouldRefreshRemoteWindowQueuedInputAfterFocus(focusConfig, request.config)) {
        request.config.daemonReceivedAtMs = receivedAtMs;
        request.refreshReceivedAtAfterFocusConfig = null;
      }
    }
  };
  const startChild = () => {
    if (child && !child.killed) {
      return child;
    }
    stderrBuffer = "";
    stdoutBuffer = "";
    const createProcess = options.processFactory || ((command, args, spawnOptions) => (0, import_node_child_process2.spawn)(command, args, spawnOptions));
    const currentChild = createProcess(options.swiftBinary, ["-e", MACOS_REMOTE_WINDOW_INPUT_SWIFT], {
      windowsHide: true,
      env: process.env
    });
    child = currentChild;
    ready = false;
    currentChild.stdout.setEncoding("utf8");
    currentChild.stderr.setEncoding("utf8");
    currentChild.stdout.on("data", (chunk) => {
      stdoutBuffer += String(chunk);
      let newlineIndex = stdoutBuffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const rawLine = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (rawLine) {
          try {
            const response = JSON.parse(rawLine);
            if (response.ready === true) {
              ready = true;
              resolveWarmWaiters();
              pump();
              newlineIndex = stdoutBuffer.indexOf("\n");
              continue;
            }
            if (active) {
              const request = active;
              active = null;
              if (request.timeout) {
                clearTimeout(request.timeout);
                request.timeout = null;
              }
              if (response.ok === true) {
                refreshQueueAfterSuccessfulFocus(request.config);
                request.resolve();
              } else {
                request.reject(new Error(String(response.error || "remote window input event failed")));
              }
              pump();
            }
          } catch (error) {
            if (active) {
              const request = active;
              active = null;
              if (request.timeout) {
                clearTimeout(request.timeout);
                request.timeout = null;
              }
              request.reject(error instanceof Error ? error : new Error("remote window input helper returned invalid JSON"));
              pump();
            }
          }
        }
        newlineIndex = stdoutBuffer.indexOf("\n");
      }
    });
    currentChild.stderr.on("data", (chunk) => {
      stderrBuffer = (stderrBuffer + String(chunk)).slice(-4096);
    });
    currentChild.on("error", (error) => {
      const message = stderrSummary();
      if (child === currentChild) {
        child = null;
        ready = false;
      }
      const wrapped = new Error(message ? `${error.message}
${message}` : error.message);
      rejectWarmWaiters(wrapped);
      rejectAll(wrapped);
    });
    currentChild.on("exit", (code, signal) => {
      const message = [
        `remote window input helper exited code=${code ?? "null"} signal=${signal ?? "null"}`,
        stderrSummary()
      ].filter(Boolean).join("\n");
      if (child === currentChild) {
        child = null;
        ready = false;
      }
      if (!disposed) {
        const error = new Error(message);
        rejectWarmWaiters(error);
        rejectAll(error);
      }
    });
    return currentChild;
  };
  const waitUntilReady = () => {
    if (disposed) {
      return Promise.reject(new Error("remote window input helper is disposed"));
    }
    const helperProcess = startChild();
    if (ready && child === helperProcess && !helperProcess.killed) {
      return Promise.resolve();
    }
    return new Promise((resolve4, reject) => {
      const waiter = {
        resolve: resolve4,
        reject,
        timeout: setTimeout(() => {
          const index = warmWaiters.indexOf(waiter);
          if (index >= 0) {
            warmWaiters.splice(index, 1);
          }
          const message = stderrSummary();
          const error = new Error(message ? `remote window input helper did not become ready before timeout: ${message}` : "remote window input helper did not become ready before timeout");
          if (child === helperProcess && !helperProcess.killed) {
            child.kill("SIGTERM");
            child = null;
            ready = false;
          }
          reject(error);
        }, REMOTE_WINDOW_INPUT_HELPER_READY_TIMEOUT_MS)
      };
      warmWaiters.push(waiter);
    });
  };
  const startReadyPump = () => {
    if (waitingForReadyPump) {
      return;
    }
    waitingForReadyPump = true;
    waitUntilReady().then(() => {
      waitingForReadyPump = false;
      pump();
    }).catch((error) => {
      waitingForReadyPump = false;
      rejectAll(error);
    });
  };
  const pump = () => {
    if (disposed || active || queue.length === 0) {
      return;
    }
    const request = queue.shift();
    if (!request) {
      return;
    }
    if (rejectIfStale(request)) {
      pump();
      return;
    }
    const helperProcess = startChild();
    if (!ready) {
      queue.unshift(request);
      startReadyPump();
      return;
    }
    active = request;
    request.timeout = setTimeout(() => {
      if (active !== request) {
        return;
      }
      active = null;
      rejectRequest(request, new Error("remote window input helper timed out"));
      if (child && !child.killed) {
        child.kill("SIGTERM");
      }
      if (child === helperProcess) {
        child = null;
        ready = false;
      }
      pump();
    }, resolveRemoteWindowInputHelperTimeoutMs(request.config));
    helperProcess.stdin.write(`${JSON.stringify(request.config)}
`, (error) => {
      if (!error || active !== request) {
        return;
      }
      active = null;
      rejectRequest(request, error);
      pump();
    });
  };
  const findFocusConfigForQueuedInput = (config) => {
    if (active && shouldRefreshRemoteWindowQueuedInputAfterFocus(active.config, config)) {
      return active.config;
    }
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      const queuedConfig = queue[index].config;
      if (!remoteWindowInputConfigsShareTarget(queuedConfig, config)) {
        continue;
      }
      return shouldRefreshRemoteWindowQueuedInputAfterFocus(queuedConfig, config) ? queuedConfig : null;
    }
    return null;
  };
  return {
    warm() {
      return waitUntilReady();
    },
    send(config) {
      if (disposed) {
        return Promise.reject(new Error("remote window input helper is disposed"));
      }
      return new Promise((resolve4, reject) => {
        queue.push({
          config,
          resolve: resolve4,
          reject,
          timeout: null,
          refreshReceivedAtAfterFocusConfig: findFocusConfigForQueuedInput(config)
        });
        pump();
      });
    },
    dispose() {
      disposed = true;
      rejectWarmWaiters(new Error("remote window input helper disposed"));
      rejectAll(new Error("remote window input helper disposed"));
      if (child && !child.killed) {
        child.kill("SIGTERM");
      }
      child = null;
      ready = false;
    }
  };
}
function buildRemoteWindowInputConfig(payload, target, options = {}) {
  return {
    daemonReceivedAtMs: Number.isFinite(options.daemonReceivedAtMs) ? Number(options.daemonReceivedAtMs) : Date.now(),
    pid: target.videoTarget.pid,
    appBundleId: target.videoTarget.appBundleId,
    focusPolicy: target.focusPolicy,
    window: {
      windowId: target.videoTarget.windowId,
      title: target.videoTarget.title,
      bounds: target.videoTarget.windowBoundsTopLeftPx
    },
    clientSentAt: payload.clientSentAt,
    event: payload.event
  };
}
function isRemoteWindowInputConfigStale(config, nowMs = Date.now(), staleMs = REMOTE_WINDOW_INPUT_STALE_MS) {
  if (!Number.isFinite(config.daemonReceivedAtMs)) {
    return true;
  }
  return nowMs - Number(config.daemonReceivedAtMs) > staleMs;
}
function normalizeRtcDescription(description, expectedType) {
  if (!description || description.type !== expectedType || typeof description.sdp !== "string") {
    throw new Error(`remote window daemon expected ${expectedType} description`);
  }
  return {
    type: expectedType,
    sdp: description.sdp
  };
}
function normalizeIceCandidate(candidate) {
  const candidateLike = typeof candidate.toJSON === "function" ? candidate.toJSON() : candidate;
  return {
    candidate: String(candidateLike.candidate || ""),
    sdpMid: candidateLike.sdpMid ?? null,
    sdpMLineIndex: candidateLike.sdpMLineIndex ?? null,
    usernameFragment: candidateLike.usernameFragment ?? null
  };
}
function normalizeRemoteWindowVideoBitrateConfig(input) {
  if (!input) {
    return null;
  }
  const defaults = (() => {
    switch (input.preset) {
      case "2mbps":
        return { bitrateMbps: 2, maxFrameRateFps: 30 };
      case "5mbps":
        return { bitrateMbps: 5, maxFrameRateFps: 30 };
      case "10mbps":
        return { bitrateMbps: 10, maxFrameRateFps: 30 };
      case "20mbps":
        return { bitrateMbps: 20, maxFrameRateFps: 30 };
      case "fullscreen":
        return { bitrateMbps: 20, maxFrameRateFps: 60 };
      default:
        throw new Error(`remote window video bitrate preset is invalid: ${String(input.preset)}`);
    }
  })();
  const bitrateMbps = defaults.bitrateMbps;
  const maxBitrateBps = bitrateMbps * 1e6;
  if (input.bitrateMbps !== bitrateMbps || !Number.isFinite(input.maxBitrateBps) || input.maxBitrateBps <= 0 || input.maxBitrateBps > maxBitrateBps) {
    throw new Error("remote window video bitrate config does not match its preset");
  }
  const maxFrameRateFps = input.maxFrameRateFps ?? defaults.maxFrameRateFps;
  if (!Number.isFinite(maxFrameRateFps) || maxFrameRateFps < 5 || maxFrameRateFps > defaults.maxFrameRateFps) {
    throw new Error("remote window video frame-rate config does not match its preset");
  }
  return {
    preset: input.preset,
    bitrateMbps,
    maxBitrateBps: Math.floor(input.maxBitrateBps),
    maxFrameRateFps
  };
}
async function applyRemoteWindowVideoBitrate(sender, config) {
  if (!sender || typeof sender.getParameters !== "function" || typeof sender.setParameters !== "function") {
    return {
      applied: false,
      reason: "remote window video bitrate control is not available on this WebRTC sender"
    };
  }
  const currentParameters = sender.getParameters();
  const currentEncodings = Array.isArray(currentParameters.encodings) ? currentParameters.encodings : [];
  if (currentEncodings.length === 0) {
    return {
      applied: false,
      reason: "remote window video bitrate sender has no encodings to update"
    };
  }
  const nextParameters = {
    ...currentParameters,
    encodings: currentEncodings.map((encoding) => ({
      ...encoding,
      maxBitrate: config.maxBitrateBps,
      maxFramerate: config.maxFrameRateFps
    }))
  };
  await sender.setParameters(nextParameters);
  return { applied: true, videoBitrate: config };
}
function formatRemoteWindowVideoBitrateError(error) {
  if (error instanceof Error) {
    return error.message || error.name || "remote window video bitrate could not be applied";
  }
  const message = String(error || "").trim();
  return message || "remote window video bitrate could not be applied";
}
function addRemoteWindowVideoTrack(peerConnection, videoTrack) {
  return peerConnection.addTrack(videoTrack);
}
function validateStreamTargetForCapture(target) {
  if (!target.streamTargetId.trim()) {
    throw new Error("remote window stream target id is required");
  }
  const windowBounds = validateRect(target.videoTarget.windowBoundsTopLeftPx, "remote-window.windowBoundsTopLeftPx");
  const cropRect = target.videoTarget.cropRectTopLeftPx ? validateRect(target.videoTarget.cropRectTopLeftPx, "remote-window.cropRectTopLeftPx") : null;
  if (!cropRect) {
    throw new Error("remote window stream target requires cropRectTopLeftPx");
  }
  if (cropRect.width <= 0 || cropRect.height <= 0) {
    throw new Error("remote window stream crop rectangle must be drawable");
  }
  assertPaneCropWithinWindow(windowBounds, cropRect, target.streamTargetId);
  return {
    windowBounds,
    cropRect
  };
}
function convertRgbaToI420Frame(frame, convert) {
  const width = Math.max(1, Math.floor(frame.width));
  const height = Math.max(1, Math.floor(frame.height));
  const chromaWidth = Math.ceil(width / 2);
  const chromaHeight = Math.ceil(height / 2);
  const i420 = {
    width,
    height,
    data: new Uint8Array(width * height + chromaWidth * chromaHeight * 2)
  };
  convert({
    width,
    height,
    data: frame.rgba
  }, i420);
  return i420;
}
function buildScreenCaptureKitConfig(target, frameRate) {
  const { windowBounds, cropRect } = validateStreamTargetForCapture(target);
  return {
    windowId: target.videoTarget.windowId,
    appBundleId: target.videoTarget.appBundleId,
    title: target.videoTarget.title,
    windowBounds,
    cropRect,
    frameRate: Math.max(1, Math.floor(frameRate)),
    queueDepth: 1
  };
}
function stopChildProcess(child) {
  if (child.exitCode !== null || child.killed) {
    return;
  }
  child.kill("SIGTERM");
}
function startScreenCaptureKitFrameSource(target, options) {
  const captureConfig = buildScreenCaptureKitConfig(target, options.frameRate);
  const child = (0, import_node_child_process2.spawn)(options.swiftBinary, ["-e", SCREEN_CAPTURE_KIT_FRAME_SOURCE_SWIFT], {
    env: {
      ...process.env,
      ZTERM_REMOTE_WINDOW_CAPTURE_CONFIG: JSON.stringify(captureConfig)
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  child.stdin.end();
  let stdoutBuffer = Buffer.alloc(0);
  let stderrBuffer = "";
  let firstFrameResolved = false;
  let stopped = false;
  let frameWidth = Math.max(1, Math.floor(captureConfig.cropRect.width));
  let frameHeight = Math.max(1, Math.floor(captureConfig.cropRect.height));
  const cleanupListeners = () => {
    child.stdout.removeListener("data", onStdout);
    child.stderr.removeListener("data", onStderr);
    child.removeListener("error", onChildError);
    child.removeListener("exit", onChildExit);
  };
  const frameSource = {
    get width() {
      return frameWidth;
    },
    get height() {
      return frameHeight;
    },
    frameRate: Math.max(1, Math.floor(options.frameRate)),
    stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      cleanupListeners();
      stopChildProcess(child);
    }
  };
  let resolveStart = () => void 0;
  let rejectStart = () => void 0;
  const startup = new Promise((resolve4, reject) => {
    resolveStart = resolve4;
    rejectStart = reject;
  });
  const startupTimer = setTimeout(() => {
    if (firstFrameResolved || stopped) {
      return;
    }
    frameSource.stop();
    rejectStart(new Error(buildScreenCaptureKitStartupTimeoutMessage(
      stderrBuffer,
      options.startupTimeoutMs
    )));
  }, Math.max(1, options.startupTimeoutMs));
  function fail(error) {
    if (!firstFrameResolved) {
      clearTimeout(startupTimer);
      frameSource.stop();
      rejectStart(error);
      return;
    }
    options.onError(error);
  }
  function emitFrame(width, height, rgba) {
    frameWidth = width;
    frameHeight = height;
    const frame = {
      width,
      height,
      rgba: new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength)
    };
    options.onFrame(frame);
    if (!firstFrameResolved) {
      firstFrameResolved = true;
      clearTimeout(startupTimer);
      resolveStart(frameSource);
    }
  }
  function onStdout(chunk) {
    stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
    while (stdoutBuffer.length >= 16) {
      if (!stdoutBuffer.subarray(0, 4).equals(REMOTE_WINDOW_CAPTURE_FRAME_MAGIC)) {
        fail(new Error("ScreenCaptureKit frame stream header mismatch"));
        return;
      }
      const width = stdoutBuffer.readUInt32LE(4);
      const height = stdoutBuffer.readUInt32LE(8);
      const byteLength = stdoutBuffer.readUInt32LE(12);
      if (width === 0 || height === 0 || byteLength !== width * height * 4) {
        fail(new Error("ScreenCaptureKit frame stream emitted invalid frame dimensions"));
        return;
      }
      const packetLength = 16 + byteLength;
      if (stdoutBuffer.length < packetLength) {
        return;
      }
      const rgba = Buffer.from(stdoutBuffer.subarray(16, packetLength));
      stdoutBuffer = stdoutBuffer.subarray(packetLength);
      if (!stopped) {
        emitFrame(width, height, rgba);
      }
    }
  }
  function onStderr(chunk) {
    stderrBuffer = `${stderrBuffer}${chunk.toString("utf8")}`;
    stderrBuffer = stderrBuffer.slice(-1200);
  }
  function onChildError(error) {
    fail(new Error(`ScreenCaptureKit capture process failed: ${error.message}`));
  }
  function onChildExit(code, signal) {
    if (stopped) {
      return;
    }
    const detail = truncateRemoteWindowErrorMessage(stderrBuffer || `capture process exited code=${code ?? "null"} signal=${signal ?? "null"}`);
    fail(new Error(`ScreenCaptureKit capture process exited: ${detail}`));
  }
  child.stdout.on("data", onStdout);
  child.stderr.on("data", onStderr);
  child.on("error", onChildError);
  child.on("exit", onChildExit);
  return startup;
}
function parseIterm2Catalog(stdout) {
  const parsed = JSON.parse(stdout);
  if (!parsed || !Array.isArray(parsed.windows)) {
    throw new Error("iTerm2 catalog missing windows");
  }
  return parsed;
}
function parseMacosAppWindowCatalog(stdout) {
  const parsed = JSON.parse(stdout);
  if (!parsed || !Array.isArray(parsed.windows)) {
    throw new Error("macOS app window catalog missing windows");
  }
  return parsed;
}
function createRemoteWindowStreamDaemonRuntime(deps) {
  const platform = deps.platform || process.platform;
  const pythonBinary = (deps.pythonBinary || process.env.ZTERM_ITERM2_PYTHON || "python3").trim();
  const swiftBinary = (deps.swiftBinary || process.env.ZTERM_MACOS_SWIFT || "swift").trim();
  const iterm2PythonTimeoutMs = deps.iterm2PythonTimeoutMs || DEFAULT_ITERM2_PYTHON_TIMEOUT_MS;
  const appWindowCatalogTimeoutMs = deps.appWindowCatalogTimeoutMs || DEFAULT_MACOS_APP_WINDOW_CATALOG_TIMEOUT_MS;
  const captureStartupTimeoutMs = deps.captureStartupTimeoutMs || DEFAULT_SCREEN_CAPTURE_KIT_STARTUP_TIMEOUT_MS;
  const defaultFrameRate = deps.frameRate || DEFAULT_REMOTE_WINDOW_FRAME_RATE;
  const runIterm2Python = deps.runIterm2Python || runDefaultIterm2Python;
  const runMacosAppWindowCatalog = deps.runMacosAppWindowCatalog || runDefaultMacosAppWindowCatalog;
  let remoteWindowInputHelper = null;
  const getRemoteWindowInputHelper = () => {
    if (!remoteWindowInputHelper) {
      remoteWindowInputHelper = deps.remoteWindowInputHelperFactory ? deps.remoteWindowInputHelperFactory({ swiftBinary }) : createDefaultRemoteWindowInputHelper({ swiftBinary });
    }
    return remoteWindowInputHelper;
  };
  const warmRemoteWindowInputHelperForTarget = async (target) => {
    if (platform !== "darwin" || deps.runRemoteWindowInputEvent || target.inputRoute !== "os-event" || target.focusPolicy !== "bring-to-focus") {
      return;
    }
    await getRemoteWindowInputHelper().warm();
  };
  const runRemoteWindowInputEvent = deps.runRemoteWindowInputEvent || ((payload, target, options) => getRemoteWindowInputHelper().send(buildRemoteWindowInputConfig(payload, target, {
    daemonReceivedAtMs: options.daemonReceivedAtMs
  })));
  const now = deps.now || (() => (/* @__PURE__ */ new Date()).toISOString());
  const captureSourceFactory = deps.captureSourceFactory || startScreenCaptureKitFrameSource;
  const createPeerConnection = deps.peerConnectionFactory || ((configuration) => new RTCPeerConnection2(configuration));
  const createRtcSessionDescription = deps.rtcSessionDescriptionFactory || ((description) => new RTCSessionDescription2(description));
  const createRtcIceCandidate = deps.rtcIceCandidateFactory || ((candidate) => new RTCIceCandidate2(candidate));
  const createVideoSource = deps.videoSourceFactory || (() => new nonstandard.RTCVideoSource({ isScreencast: true }));
  const rgbaToI420 = deps.rgbaToI420 || nonstandard.rgbaToI420;
  const activeStreams = /* @__PURE__ */ new Map();
  const targetCatalogCacheTtlMs = Math.max(
    0,
    Math.floor(deps.targetCatalogCacheTtlMs ?? DEFAULT_REMOTE_WINDOW_TARGET_CATALOG_CACHE_TTL_MS)
  );
  const nowMs = deps.nowMs || Date.now;
  const targetCatalogCache = /* @__PURE__ */ new Map();
  const targetCatalogRefreshes = /* @__PURE__ */ new Map();
  async function queryIterm2Catalog() {
    const stdout = await runIterm2Python(ITERM2_CATALOG_PYTHON, {
      pythonBinary,
      timeoutMs: iterm2PythonTimeoutMs
    });
    return parseIterm2Catalog(stdout);
  }
  async function queryMacosAppWindowCatalog() {
    const stdout = await runMacosAppWindowCatalog(MACOS_APP_WINDOW_CATALOG_SWIFT, {
      swiftBinary,
      timeoutMs: appWindowCatalogTimeoutMs
    });
    return parseMacosAppWindowCatalog(stdout);
  }
  async function listTargetsLive(payload) {
    const createdAt = now();
    const includeAppWindows = payload.includeAppWindows !== false;
    const includeIterm2 = payload.includeIterm2 !== false;
    const targets = [];
    const errors = [];
    let macosAppWindowCatalogOk = false;
    let macosAppWindowCatalog = null;
    if (includeAppWindows) {
      try {
        macosAppWindowCatalog = await queryMacosAppWindowCatalog();
        targets.push(...buildMacosAppWindowTargets(macosAppWindowCatalog, createdAt));
        macosAppWindowCatalogOk = true;
      } catch (error) {
        const message = summarizeRemoteWindowCatalogError(error, "macOS app window catalog unavailable");
        errors.push(remoteWindowError(payload, "app_window_catalog_unavailable", message || "macOS app window catalog unavailable"));
      }
    }
    let catalog = null;
    if (includeIterm2) {
      try {
        catalog = await queryIterm2Catalog();
      } catch (error) {
        const message = summarizeRemoteWindowCatalogError(error, "iTerm2 Python API unavailable");
        errors.push(remoteWindowError(payload, "iterm2_api_unavailable", message || "iTerm2 Python API unavailable"));
      }
    }
    let tmuxTargets = /* @__PURE__ */ new Map();
    if (catalog) {
      if (!macosAppWindowCatalogOk) {
        try {
          macosAppWindowCatalog = await queryMacosAppWindowCatalog();
          macosAppWindowCatalogOk = true;
        } catch (error) {
          const message = summarizeRemoteWindowCatalogError(error, "macOS app window catalog unavailable");
          errors.push(remoteWindowError(payload, "app_window_catalog_unavailable", message || "macOS app window catalog unavailable"));
        }
      }
      try {
        tmuxTargets = parseTmuxClientTargets(deps.runTmux([
          "list-clients",
          "-F",
          "#{client_tty}	#{session_name}	#{window_id}	#{pane_id}"
        ]).stdout);
      } catch {
        tmuxTargets = /* @__PURE__ */ new Map();
      }
    }
    if (catalog) {
      try {
        targets.push(...buildRemoteWindowStreamTargets(catalog, tmuxTargets, createdAt, {
          includeAppWindowTargets: false,
          macosAppWindowCatalog,
          requireCaptureWindowForPanes: true
        }));
      } catch (error) {
        const message = summarizeRemoteWindowCatalogError(error, "remote window target manifest invalid");
        errors.push(remoteWindowError(payload, "remote_window_manifest_invalid", message || "remote window target manifest invalid"));
      }
    }
    if (targets.length > 0) {
      return {
        requestId: payload.requestId,
        targets,
        ...errors.length > 0 ? { errors } : {}
      };
    }
    return errors[0] || {
      requestId: payload.requestId,
      targets: []
    };
  }
  function startTargetCatalogRefresh(cacheKey, payload) {
    const existing = targetCatalogRefreshes.get(cacheKey);
    if (existing) {
      return existing;
    }
    const refreshPayload = {
      ...payload,
      requestId: payload.requestId || `rw-catalog-refresh-${nowMs()}`
    };
    const refresh = listTargetsLive(refreshPayload).catch((error) => remoteWindowError(
      refreshPayload,
      "remote_window_catalog_failed",
      error instanceof Error ? error.message : "remote window catalog failed"
    )).then((result) => {
      if ("targets" in result) {
        targetCatalogCache.set(cacheKey, {
          updatedAtMs: nowMs(),
          response: cloneRemoteWindowTargetCatalogResponse(result, result.requestId)
        });
      }
      return result;
    }).finally(() => {
      if (targetCatalogRefreshes.get(cacheKey) === refresh) {
        targetCatalogRefreshes.delete(cacheKey);
      }
    });
    targetCatalogRefreshes.set(cacheKey, refresh);
    return refresh;
  }
  async function refreshTargetCatalog(cacheKey, payload) {
    const result = await startTargetCatalogRefresh(cacheKey, payload);
    return cloneRemoteWindowTargetCatalogResult(result, payload.requestId);
  }
  function warmTargetCatalog() {
    if (platform !== "darwin") {
      return;
    }
    const payload = {
      requestId: `rw-catalog-warm-${nowMs()}`,
      includeAppWindows: true,
      includeIterm2: true
    };
    void startTargetCatalogRefresh(
      buildRemoteWindowTargetCatalogCacheKey(payload),
      payload
    );
  }
  async function listTargets(payload) {
    if (!payload.requestId) {
      return remoteWindowError(payload, "remote_window_request_invalid", "remote window target request requires requestId");
    }
    if (platform !== "darwin") {
      return remoteWindowError(payload, "remote_window_platform_unsupported", "remote window stream catalog is only available on macOS daemon hosts");
    }
    const cacheKey = buildRemoteWindowTargetCatalogCacheKey(payload);
    const cached = targetCatalogCache.get(cacheKey) || null;
    const cacheAgeMs = cached ? nowMs() - cached.updatedAtMs : Number.POSITIVE_INFINITY;
    const cacheFresh = Boolean(cached && cacheAgeMs >= 0 && cacheAgeMs < targetCatalogCacheTtlMs);
    if (!payload.forceRefresh && cached && cacheFresh) {
      return cloneRemoteWindowTargetCatalogResponse(cached.response, payload.requestId);
    }
    if (!payload.forceRefresh && cached) {
      void startTargetCatalogRefresh(cacheKey, payload);
      return cloneRemoteWindowTargetCatalogResponse(cached.response, payload.requestId);
    }
    return refreshTargetCatalog(cacheKey, payload);
  }
  function buildStreamError(payload, code, message) {
    return {
      requestId: payload.requestId || "",
      ...payload.streamId ? { streamId: payload.streamId } : {},
      code,
      message: truncateRemoteWindowErrorMessage(message || code)
    };
  }
  function cleanupStream(entry, reason) {
    if (entry.cleanupDone) {
      return false;
    }
    entry.cleanupDone = true;
    activeStreams.delete(entry.streamId);
    try {
      entry.captureSource?.stop();
    } catch {
    }
    entry.captureSource = null;
    try {
      entry.videoTrack.stop();
    } catch {
    }
    entry.peerConnection.onicecandidate = null;
    entry.peerConnection.onconnectionstatechange = null;
    try {
      entry.peerConnection.close();
    } catch {
    }
    entry.handlers.sendStatus?.({
      requestId: entry.requestId,
      streamId: entry.streamId,
      phase: "stopped",
      framesSent: entry.framesSent,
      message: reason
    });
    return true;
  }
  function isCurrentStream(entry) {
    return activeStreams.get(entry.streamId) === entry && !entry.cleanupDone;
  }
  function validateRemoteWindowInput(payload, entry) {
    if (!payload.requestId || !payload.streamId || !payload.targetId) {
      throw new Error("remote window input requires requestId, streamId, and targetId");
    }
    if (payload.targetId !== entry.targetId) {
      throw new Error(`remote window input target mismatch: ${payload.targetId}`);
    }
    if (entry.target.inputRoute === "os-event" && entry.target.focusPolicy !== "bring-to-focus") {
      throw new Error("remote window OS input requires bring-to-focus policy");
    }
    if (entry.target.inputRoute !== "os-event") {
      throw new Error(`remote window input route is not implemented: ${entry.target.inputRoute}`);
    }
    if (payload.event.kind === "focus") {
      return;
    }
    if (payload.event.kind === "pointer") {
      const values = [
        payload.event.x,
        payload.event.y,
        payload.event.normalizedX,
        payload.event.normalizedY
      ];
      if (!values.every((value) => Number.isFinite(value))) {
        throw new Error("remote window pointer input coordinates are invalid");
      }
      if (payload.event.normalizedX < 0 || payload.event.normalizedX > 1 || payload.event.normalizedY < 0 || payload.event.normalizedY > 1) {
        throw new Error("remote window pointer input normalized coordinates are out of range");
      }
    }
    if (payload.event.kind === "scroll") {
      const values = [
        payload.event.x,
        payload.event.y,
        payload.event.normalizedX,
        payload.event.normalizedY,
        payload.event.deltaX,
        payload.event.deltaY
      ];
      if (!values.every((value) => Number.isFinite(value))) {
        throw new Error("remote window scroll input coordinates or delta are invalid");
      }
      if (payload.event.normalizedX < 0 || payload.event.normalizedX > 1 || payload.event.normalizedY < 0 || payload.event.normalizedY > 1) {
        throw new Error("remote window scroll input normalized coordinates are out of range");
      }
      if (payload.event.unit !== "pixel") {
        throw new Error("remote window scroll input unit is invalid");
      }
    }
    if (payload.event.kind === "gesture") {
      const values = [
        payload.event.startX,
        payload.event.startY,
        payload.event.x,
        payload.event.y,
        payload.event.startNormalizedX,
        payload.event.startNormalizedY,
        payload.event.normalizedX,
        payload.event.normalizedY,
        payload.event.deltaX,
        payload.event.deltaY,
        payload.event.durationMs,
        payload.event.velocityX,
        payload.event.velocityY
      ];
      if (!values.every((value) => Number.isFinite(value))) {
        throw new Error("remote window gesture input coordinates, delta, or timing are invalid");
      }
      if (payload.event.startNormalizedX < 0 || payload.event.startNormalizedX > 1 || payload.event.startNormalizedY < 0 || payload.event.startNormalizedY > 1 || payload.event.normalizedX < 0 || payload.event.normalizedX > 1 || payload.event.normalizedY < 0 || payload.event.normalizedY > 1) {
        throw new Error("remote window gesture input normalized coordinates are out of range");
      }
      if (payload.event.gesture !== "swipe" || payload.event.phase !== "end" || payload.event.unit !== "pixel" || payload.event.durationMs <= 0) {
        throw new Error("remote window gesture input contract is invalid");
      }
    }
    if (payload.event.kind === "key" && payload.event.phase !== "down" && payload.event.phase !== "up") {
      throw new Error("remote window key input phase is invalid");
    }
  }
  async function startStream(payload, handlers = {}) {
    if (!payload.requestId || !payload.streamId) {
      return buildStreamError(payload, "remote_window_stream_request_invalid", "remote window stream start requires requestId and streamId");
    }
    if (platform !== "darwin") {
      return buildStreamError(payload, "remote_window_platform_unsupported", "remote window stream is only available on macOS daemon hosts");
    }
    if (activeStreams.has(payload.streamId)) {
      return buildStreamError(payload, "remote_window_stream_exists", `remote window stream already exists: ${payload.streamId}`);
    }
    let entry = null;
    try {
      validateStreamTargetForCapture(payload.target);
      const inputHelperWarm = warmRemoteWindowInputHelperForTarget(payload.target).then(() => null, (error) => error instanceof Error ? error : new Error("remote window input helper warm failed"));
      const peerConnection = createPeerConnection({
        iceServers: Array.isArray(payload.iceServers) ? payload.iceServers : []
      });
      const videoSource = createVideoSource();
      const videoTrack = videoSource.createTrack();
      const requestedVideoBitrate = normalizeRemoteWindowVideoBitrateConfig(payload.videoBitrate);
      const videoSender = addRemoteWindowVideoTrack(
        peerConnection,
        videoTrack
      );
      const streamFrameRate = requestedVideoBitrate?.maxFrameRateFps ?? defaultFrameRate;
      let videoBitrate = null;
      let videoBitrateWarning = null;
      entry = {
        streamId: payload.streamId,
        requestId: payload.requestId,
        targetId: payload.target.streamTargetId,
        target: payload.target,
        peerConnection,
        videoSender: videoSender || null,
        videoSource,
        videoTrack,
        videoBitrate,
        captureSource: null,
        handlers,
        framesSent: 0,
        cleanupDone: false
      };
      activeStreams.set(payload.streamId, entry);
      peerConnection.onicecandidate = (event) => {
        if (!entry || !isCurrentStream(entry) || !event.candidate) {
          return;
        }
        handlers.sendIceCandidate?.({
          requestId: payload.requestId,
          streamId: payload.streamId,
          candidate: normalizeIceCandidate(event.candidate)
        });
      };
      peerConnection.onconnectionstatechange = () => {
        if (!entry || !isCurrentStream(entry)) {
          return;
        }
        const state = peerConnection.connectionState;
        if (state === "failed" || state === "closed") {
          cleanupStream(entry, `remote window WebRTC connection ${state}`);
        }
      };
      handlers.sendStatus?.({
        requestId: payload.requestId,
        streamId: payload.streamId,
        phase: "starting",
        ...videoBitrateWarning ? { message: `video bitrate not applied: ${videoBitrateWarning}` } : {}
      });
      await peerConnection.setRemoteDescription(createRtcSessionDescription({
        type: payload.offer.type,
        sdp: payload.offer.sdp
      }));
      const captureSource = await captureSourceFactory(payload.target, {
        frameRate: streamFrameRate,
        startupTimeoutMs: captureStartupTimeoutMs,
        swiftBinary,
        onFrame: (frame) => {
          if (!entry || !isCurrentStream(entry)) {
            return;
          }
          try {
            const i420Frame = convertRgbaToI420Frame(frame, rgbaToI420);
            entry.videoSource.onFrame(i420Frame);
            entry.framesSent += 1;
            if (entry.framesSent === 1) {
              handlers.sendStatus?.({
                requestId: payload.requestId,
                streamId: payload.streamId,
                phase: "streaming",
                framesSent: entry.framesSent,
                frameWidth: frame.width,
                frameHeight: frame.height
              });
            }
          } catch (error) {
            cleanupStream(
              entry,
              `remote window frame conversion failed: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        },
        onError: (error) => {
          if (!entry || !isCurrentStream(entry)) {
            return;
          }
          cleanupStream(entry, error.message || "remote window capture failed");
        }
      });
      if (!isCurrentStream(entry)) {
        captureSource.stop();
        throw new Error("remote window stream was closed before capture started");
      }
      entry.captureSource = captureSource;
      const inputHelperWarmError = await inputHelperWarm;
      if (inputHelperWarmError) {
        throw inputHelperWarmError;
      }
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      if (!isCurrentStream(entry)) {
        throw new Error("remote window stream was closed before media negotiation completed");
      }
      if (requestedVideoBitrate) {
        try {
          const applyResult = await applyRemoteWindowVideoBitrate(videoSender || null, requestedVideoBitrate);
          if (applyResult.applied) {
            videoBitrate = applyResult.videoBitrate;
            entry.videoBitrate = videoBitrate;
          } else {
            videoBitrateWarning = applyResult.reason;
          }
        } catch (error) {
          videoBitrateWarning = formatRemoteWindowVideoBitrateError(error);
        }
        if (videoBitrateWarning) {
          handlers.sendStatus?.({
            requestId: payload.requestId,
            streamId: payload.streamId,
            phase: "starting",
            message: `video bitrate not applied: ${videoBitrateWarning}`
          });
        }
      }
      return {
        requestId: payload.requestId,
        streamId: payload.streamId,
        targetId: payload.target.streamTargetId,
        answer: normalizeRtcDescription(peerConnection.localDescription || answer, "answer"),
        capture: {
          source: "ScreenCaptureKit",
          frameWidth: captureSource.width,
          frameHeight: captureSource.height,
          frameRate: captureSource.frameRate,
          ...entry.videoBitrate ? { maxBitrateBps: entry.videoBitrate.maxBitrateBps } : {},
          targetKind: payload.target.videoTarget.kind
        },
        transport: {
          kind: "webrtc-video"
        }
      };
    } catch (error) {
      if (entry) {
        cleanupStream(entry, error instanceof Error ? error.message : String(error));
      }
      return buildStreamError(
        payload,
        "remote_window_stream_start_failed",
        error instanceof Error ? error.message : "remote window stream start failed"
      );
    }
  }
  async function addIceCandidate(payload) {
    const entry = activeStreams.get(payload.streamId);
    if (!entry || entry.cleanupDone) {
      return false;
    }
    await entry.peerConnection.addIceCandidate(createRtcIceCandidate({
      candidate: payload.candidate.candidate,
      sdpMid: payload.candidate.sdpMid ?? null,
      sdpMLineIndex: payload.candidate.sdpMLineIndex ?? null,
      usernameFragment: payload.candidate.usernameFragment ?? null
    }));
    return true;
  }
  async function stopStream(payload) {
    if (!payload.requestId || !payload.streamId) {
      return buildStreamError(payload, "remote_window_stream_stop_invalid", "remote window stream stop requires requestId and streamId");
    }
    const entry = activeStreams.get(payload.streamId);
    if (!entry) {
      return {
        requestId: payload.requestId,
        streamId: payload.streamId,
        phase: "stopped",
        framesSent: 0,
        message: "remote window stream already stopped"
      };
    }
    const framesSent = entry.framesSent;
    cleanupStream(entry, "remote window stream stopped");
    return {
      requestId: payload.requestId,
      streamId: payload.streamId,
      phase: "stopped",
      framesSent,
      message: "remote window stream stopped"
    };
  }
  async function updateStreamQuality(payload) {
    if (!payload.requestId || !payload.streamId || !payload.targetId) {
      return buildStreamError(payload, "remote_window_stream_quality_invalid", "remote window stream quality requires requestId, streamId, and targetId");
    }
    const entry = activeStreams.get(payload.streamId);
    if (!entry || entry.cleanupDone) {
      return buildStreamError(payload, "remote_window_stream_quality_missing", `remote window stream is not active: ${payload.streamId}`);
    }
    if (payload.targetId !== entry.targetId) {
      return buildStreamError(payload, "remote_window_stream_quality_target_mismatch", `remote window stream quality target mismatch: ${payload.targetId}`);
    }
    try {
      const videoBitrate = normalizeRemoteWindowVideoBitrateConfig(payload.videoBitrate);
      if (!videoBitrate) {
        throw new Error("remote window stream quality requires videoBitrate");
      }
      const applyResult = await applyRemoteWindowVideoBitrate(entry.videoSender, videoBitrate);
      if (!applyResult.applied) {
        throw new Error(applyResult.reason);
      }
      entry.videoBitrate = applyResult.videoBitrate;
      return {
        requestId: payload.requestId,
        streamId: payload.streamId,
        targetId: payload.targetId,
        accepted: true,
        videoBitrate: applyResult.videoBitrate
      };
    } catch (error) {
      return buildStreamError(
        payload,
        "remote_window_stream_quality_failed",
        formatRemoteWindowVideoBitrateError(error)
      );
    }
  }
  async function injectInput(payload) {
    const entry = activeStreams.get(payload.streamId);
    if (!entry || entry.cleanupDone) {
      return buildStreamError(payload, "remote_window_input_stream_missing", `remote window stream is not active: ${payload.streamId || "missing"}`);
    }
    const daemonReceivedAtMs = nowMs();
    try {
      validateRemoteWindowInput(payload, entry);
      await runRemoteWindowInputEvent(payload, entry.target, {
        swiftBinary,
        runTmux: deps.runTmux,
        daemonReceivedAtMs
      });
      return {
        requestId: payload.requestId,
        streamId: payload.streamId,
        targetId: payload.targetId,
        accepted: true
      };
    } catch (error) {
      return buildStreamError(
        payload,
        "remote_window_input_failed",
        error instanceof Error ? error.message : "remote window input failed"
      );
    }
  }
  function dispose(reason = "remote window daemon runtime disposed") {
    for (const entry of Array.from(activeStreams.values())) {
      cleanupStream(entry, reason);
    }
    targetCatalogCache.clear();
    targetCatalogRefreshes.clear();
    remoteWindowInputHelper?.dispose();
    remoteWindowInputHelper = null;
  }
  if (deps.warmTargetCatalogOnStart) {
    warmTargetCatalog();
  }
  return {
    listTargets,
    startStream,
    addIceCandidate,
    stopStream,
    updateStreamQuality,
    injectInput,
    dispose
  };
}

// src/server/server.ts
var DAEMON_CONFIG = resolveDaemonRuntimeConfig();
var PORT = DAEMON_CONFIG.port || DEFAULT_BRIDGE_PORT;
var HOST = DAEMON_CONFIG.host || DEFAULT_DAEMON_HOST;
var TERMINAL_BACKEND_KIND = resolveTerminalBackendKind();
var TMUX_BINARY = TERMINAL_BACKEND_KIND === "tmux" ? resolveTmuxBinary() : "";
var WEZTERM_BACKEND = TERMINAL_BACKEND_KIND === "wezterm" ? createWezTermBackendRuntime({
  runner: createWezTermCommandRunner(resolveWezTermExecutable()),
  maxMirrorLines: DAEMON_CONFIG.terminalCacheLines
}) : null;
var DEFAULT_SESSION_NAME = process.env.ZTERM_DEFAULT_SESSION || "zterm";
var DAEMON_SESSION_NAME = DAEMON_CONFIG.sessionName || buildDaemonSessionName(PORT);
var HIDDEN_TMUX_SESSIONS = /* @__PURE__ */ new Set([DAEMON_SESSION_NAME, DEFAULT_DAEMON_SESSION_NAME, "zterm-daemon-keepalive"]);
var AUTO_COMMAND_DELAY_MS = 180;
var REQUIRED_AUTH_TOKEN = DAEMON_CONFIG.authToken;
var MAX_CAPTURED_SCROLLBACK_LINES = DAEMON_CONFIG.terminalCacheLines;
var WTERM_HOME_DIR = getWtermHomeDir((0, import_os4.homedir)());
var UPDATES_DIR = getWtermUpdatesDir((0, import_os4.homedir)());
var UPLOAD_DIR = (0, import_path6.join)(WTERM_HOME_DIR, "uploads");
var DOWNLOADS_DIR = (0, import_path6.join)((0, import_os4.homedir)(), "Downloads", "zterm");
var LOG_DIR = (0, import_path6.join)(WTERM_HOME_DIR, "logs");
var APP_UPDATE_VERSION_CODE = Number.parseInt(process.env.ZTERM_APP_UPDATE_VERSION_CODE || "", 10);
var APP_UPDATE_VERSION_NAME = (process.env.ZTERM_APP_UPDATE_VERSION_NAME || "").trim();
var APP_UPDATE_MANIFEST_URL = (process.env.ZTERM_APP_UPDATE_MANIFEST_URL || "").trim();
var WS_HEARTBEAT_INTERVAL_MS = 2e3;
var STARTUP_PORT_CONFLICT_EXIT_CODE = 78;
var DAEMON_RUNTIME_DEBUG = process.env.ZTERM_DAEMON_DEBUG_LOG === "1";
var MAX_CLIENT_DEBUG_BATCH_LOG_ENTRIES = 8;
var MAX_CLIENT_DEBUG_LOG_PAYLOAD_CHARS = 900;
var MEMORY_GUARD_INTERVAL_MS = 3e4;
var MEMORY_GUARD_MAX_RSS_BYTES = 2.5 * 1024 * 1024 * 1024;
var MEMORY_GUARD_MAX_HEAP_USED_BYTES = 1.5 * 1024 * 1024 * 1024;
var sessions = /* @__PURE__ */ new Map();
var connections = /* @__PURE__ */ new Map();
var mirrors = /* @__PURE__ */ new Map();
var scheduleStore = loadScheduleStore();
var clientRuntimeDebugStore = createRuntimeDebugStore();
var daemonRuntimeDebugStore = createRuntimeDebugStore();
var performanceTraceStore = createTerminalPerformanceTraceStore({ limit: 5e3 });
var terminalAttachTokenRuntime = createTerminalAttachTokenRuntime();
var terminalScheduleRuntime;
var terminalControlRuntime;
var terminalTransportRuntimeSendMessage;
var remoteWindowStreamRuntime;
var remoteWindowPasteRequestSeq = 0;
var terminalDebugRuntime = createTerminalDebugRuntime({
  daemonRuntimeDebugEnabled: DAEMON_RUNTIME_DEBUG,
  maxClientDebugBatchLogEntries: MAX_CLIENT_DEBUG_BATCH_LOG_ENTRIES,
  maxClientDebugLogPayloadChars: MAX_CLIENT_DEBUG_LOG_PAYLOAD_CHARS,
  clientRuntimeDebugStore,
  daemonRuntimeDebugStore,
  sessions
});
var terminalCoreSupport = createTerminalCoreSupport({
  defaultSessionName: DEFAULT_SESSION_NAME,
  maxCapturedScrollbackLines: MAX_CAPTURED_SCROLLBACK_LINES
});
var {
  logTimePrefix,
  daemonRuntimeDebug,
  setDaemonRuntimeDebugEnabled,
  summarizePayload,
  handleClientDebugLog,
  handleClientDebugSnapshot
} = terminalDebugRuntime;
var {
  resolveMirrorCacheLines,
  sanitizeSessionName,
  getMirrorKey,
  mirrorCursorEqual,
  normalizeTerminalCols,
  normalizeTerminalRows,
  normalizeBufferSyncRequestPayload
} = terminalCoreSupport;
var terminalMirrorCapture = createTerminalMirrorCaptureRuntime({
  resolveMirrorCacheLines,
  runTmux: (args) => terminalControlRuntime.runTmux(args),
  runTmuxAsync: (args) => terminalControlRuntime.runTmuxAsync(args),
  logTimePrefix,
  wezTermBackend: WEZTERM_BACKEND
});
var terminalRuntime = createTerminalRuntime({
  defaultSessionName: DEFAULT_SESSION_NAME,
  defaultViewport: DEFAULT_TERMINAL_SESSION_VIEWPORT,
  sessions,
  mirrors,
  sendMessage: (session, message) => terminalTransportRuntimeSendMessage(session, message),
  sendText: (transport, text) => terminalTransportRuntime.sendText(transport, text),
  recordPerformanceTrace: (record) => performanceTraceStore.record(record),
  sendScheduleStateToSession: (session, sessionName) => terminalScheduleRuntime.sendScheduleStateToSession(session, sessionName),
  buildConnectedPayload: (sessionId, requestOrigin) => terminalHttpRuntime.buildConnectedPayload(sessionId, requestOrigin),
  buildBufferHeadPayload: (sessionId, mirror) => buildBufferHeadPayload(sessionId, mirror),
  buildChangedRangesBufferSyncPayload: (mirror, changedRanges) => buildChangedRangesBufferSyncPayload(mirror, changedRanges),
  sanitizeSessionName,
  getMirrorKey,
  normalizeTerminalCols,
  normalizeTerminalRows,
  resolveAttachGeometry,
  readTmuxPaneMetrics: (sessionName) => terminalMirrorCapture.readTmuxPaneMetrics(sessionName),
  assertTmuxSessionExists: (sessionName) => {
    if (WEZTERM_BACKEND) {
      if (!WEZTERM_BACKEND.listSessions().some((session) => session.sessionName === sessionName)) {
        throw new Error(`wezterm session not found: ${sessionName}`);
      }
      return;
    }
    terminalControlRuntime.runTmux(["has-session", "-t", sessionName]);
  },
  captureMirrorAuthoritativeBufferFromTmux: terminalMirrorCapture.captureMirrorAuthoritativeBufferFromTmux,
  mirrorBufferChanged: (mirror, previousStartIndex, previousLines) => findChangedIndexedRanges({
    previousStartIndex,
    previousLines,
    nextStartIndex: mirror.bufferStartIndex,
    nextLines: mirror.bufferLines
  }),
  mirrorCursorEqual,
  writeToLiveMirror: (sessionName, payload, appendEnter2) => terminalControlRuntime.writeToLiveMirror(sessionName, payload, appendEnter2),
  enqueueLiveMirrorInput: (sessionName, payload, appendEnter2, shouldWrite) => terminalControlRuntime.enqueueLiveMirrorInput(sessionName, payload, appendEnter2, shouldWrite),
  disposeLiveMirrorInputBatch: (sessionName, reason) => terminalControlRuntime.disposeLiveMirrorInputBatch(sessionName, reason),
  writeToTmuxSession: (sessionName, payload, appendEnter2) => terminalControlRuntime.writeToTmuxSession(sessionName, payload, appendEnter2),
  autoCommandDelayMs: AUTO_COMMAND_DELAY_MS,
  waitMs: (delayMs) => new Promise((resolve4) => setTimeout(resolve4, delayMs)),
  runTmux: (args) => terminalControlRuntime.runTmux(args),
  daemonRuntimeDebug,
  logTimePrefix
});
var terminalFileTransferRuntime = createTerminalFileTransferRuntime({
  uploadDir: UPLOAD_DIR,
  downloadsDir: DOWNLOADS_DIR,
  wtermHomeDir: WTERM_HOME_DIR,
  platform: process.platform,
  sendMessage: (session, message) => terminalTransportRuntimeSendMessage(session, message),
  getSessionMirror: terminalRuntime.getSubscriberMirror,
  scheduleMirrorLiveSync: terminalRuntime.scheduleMirrorLiveSync,
  writeToTmuxSession: (sessionName, payload, appendEnter2) => terminalControlRuntime.writeToTmuxSession(sessionName, payload, appendEnter2),
  writeToLiveMirror: (sessionName, payload, appendEnter2) => terminalControlRuntime.writeToLiveMirror(sessionName, payload, appendEnter2),
  readTmuxPaneCurrentPath: (sessionName) => terminalMirrorCapture.readTmuxPaneCurrentPath(sessionName),
  runCommand: (command, args) => {
    terminalControlRuntime.runCommand(command, args);
  },
  pasteImageToRemoteWindow: async (_session, target) => {
    const requestPrefix = `paste-image-${Date.now()}-${remoteWindowPasteRequestSeq += 1}`;
    const payloads = buildRemoteWindowImagePasteInputPayloads({
      requestPrefix,
      streamId: target.streamId,
      targetId: target.targetId
    });
    for (const payload of payloads) {
      const result = await remoteWindowStreamRuntime.injectInput(payload);
      if (!("accepted" in result) || !result.accepted) {
        throw new Error("message" in result ? result.message : "remote window image paste rejected");
      }
    }
  },
  captureRemoteScreenshot: captureRemoteScreenshotWithDaemon,
  logTimePrefix
});
terminalControlRuntime = createTerminalControlRuntime({
  tmuxBinary: TMUX_BINARY,
  defaultSessionName: DEFAULT_SESSION_NAME,
  hiddenTmuxSessions: HIDDEN_TMUX_SESSIONS,
  tmuxSocketDir: (0, import_path6.join)(WTERM_HOME_DIR, "tmux"),
  mirrors,
  getMirrorKey,
  sanitizeSessionName,
  daemonRuntimeDebug,
  wezTermBackend: WEZTERM_BACKEND
});
var {
  runTmux,
  writeToTmuxSession,
  writeToLiveMirror,
  listTmuxSessions,
  createDetachedTmuxSession,
  closeDetachedTerminalSession,
  renameTmuxSession
} = terminalControlRuntime;
remoteWindowStreamRuntime = createRemoteWindowStreamDaemonRuntime({
  platform: process.platform,
  warmTargetCatalogOnStart: true,
  runTmux
});
terminalControlRuntime.ensureTmuxServerRunning();
terminalRuntime.restorePersistedAdaptiveWidthBaselines(listTmuxSessions());
var terminalTransportRuntime = createTerminalTransportRuntime({
  sessions,
  connections,
  daemonRuntimeDebug,
  summarizePayload,
  recordPerformanceTrace: (record) => performanceTraceStore.record(record)
});
var {
  createWebSocketSessionTransport,
  createRtcSessionTransport,
  sendTransportMessage,
  sendMessage,
  broadcastRuntimeDebugControl,
  createTransportConnection
} = terminalTransportRuntime;
terminalTransportRuntimeSendMessage = sendMessage;
terminalScheduleRuntime = createTerminalScheduleRuntime({
  initialJobs: scheduleStore.jobs,
  saveJobs: (jobs) => {
    saveScheduleStore(jobs);
  },
  executeJob: async (job) => dispatchScheduledJob(
    {
      writeToLiveMirror,
      writeToTmuxSession
    },
    job
  ),
  sessions,
  sendMessage
});
var { scheduleEngine, sendScheduleStateToSession } = terminalScheduleRuntime;
var terminalHttpRuntime = createTerminalHttpRuntime({
  host: HOST,
  port: PORT,
  daemonHostId: DAEMON_CONFIG.daemonHostId,
  requiredAuthToken: REQUIRED_AUTH_TOKEN,
  updatesDir: UPDATES_DIR,
  appUpdateVersionCode: APP_UPDATE_VERSION_CODE,
  appUpdateVersionName: APP_UPDATE_VERSION_NAME,
  appUpdateManifestUrl: APP_UPDATE_MANIFEST_URL,
  sessions,
  mirrors,
  clientRuntimeDebugStore,
  daemonRuntimeDebugStore,
  performanceTraceStore,
  resolveDebugRouteLimit,
  broadcastRuntimeDebugControl,
  setDaemonRuntimeDebugEnabled,
  logTimePrefix
});
var terminalMessageRuntime = createTerminalMessageRuntime({
  sessions,
  sendTransportMessage,
  sendMessage,
  normalizeBufferSyncRequestPayload,
  getSessionMirror: terminalRuntime.getSubscriberMirror,
  sendBufferHeadToSession: terminalRuntime.sendBufferHeadToSession,
  scheduleMirrorLiveSync: terminalRuntime.scheduleMirrorLiveSync,
  refreshMirrorHeadForSession: terminalRuntime.refreshMirrorHeadForSession,
  handleInput: terminalRuntime.handleInput,
  closeSession: terminalRuntime.closeTransportSubscriber,
  terminalFileTransferRuntime,
  remoteWindowStreamRuntime,
  handleClientDebugLog,
  handleClientDebugSnapshot,
  daemonRuntimeDebug,
  controlRuntimeDeps: {
    sessions,
    mirrors,
    issueSessionTransportToken: terminalAttachTokenRuntime.issueSessionTransportToken,
    consumeSessionTransportToken: terminalAttachTokenRuntime.consumeSessionTransportToken,
    scheduleEngine,
    sendTransportMessage,
    sendMessage,
    sendScheduleStateToSession,
    listTmuxSessions,
    createDetachedTmuxSession,
    closeDetachedTerminalSession,
    renameTmuxSession,
    runTmux,
    sanitizeSessionName,
    createTransportSubscriber: (connection) => terminalRuntime.createTransportSubscriber(connection),
    createMuxChannelSubscriber: (connection, channelId) => terminalRuntime.createMuxChannelSubscriber(connection, channelId),
    bindConnectionToSubscriber: (connection, subscriber) => terminalRuntime.bindConnectionToSubscriber(connection, subscriber),
    getMirrorKey,
    attachTmux: terminalRuntime.attachTmux,
    handleAdaptiveResize: terminalRuntime.handleAdaptiveResize,
    destroyMirror: terminalRuntime.destroyMirror
  }
});
var server = (0, import_http.createServer)((request, response) => terminalHttpRuntime.handleHttpRequest(request, response));
var wss = new import_websocket_server.default({
  noServer: true,
  perMessageDeflate: {
    threshold: 256,
    clientNoContextTakeover: true,
    serverNoContextTakeover: true
  }
});
var terminalDaemonRuntime = createTerminalDaemonRuntime({
  host: HOST,
  port: PORT,
  requiredAuthToken: REQUIRED_AUTH_TOKEN,
  updatesDir: UPDATES_DIR,
  tmuxBinary: TMUX_BINARY,
  defaultSessionName: DEFAULT_SESSION_NAME,
  logDir: LOG_DIR,
  configDisplayPath: DAEMON_CONFIG.configFound ? WTERM_CONFIG_DISPLAY_PATH : `${WTERM_CONFIG_DISPLAY_PATH} (not found)`,
  authLabel: REQUIRED_AUTH_TOKEN ? `enabled (${DAEMON_CONFIG.authSource})` : "disabled",
  relayLabel: DAEMON_CONFIG.relay ? `${DAEMON_CONFIG.relay.relayUrl} (host=${DAEMON_CONFIG.relay.hostId})` : "disabled",
  terminalCacheLines: MAX_CAPTURED_SCROLLBACK_LINES,
  wsHeartbeatIntervalMs: WS_HEARTBEAT_INTERVAL_MS,
  memoryGuardIntervalMs: MEMORY_GUARD_INTERVAL_MS,
  memoryGuardMaxRssBytes: MEMORY_GUARD_MAX_RSS_BYTES,
  memoryGuardMaxHeapUsedBytes: MEMORY_GUARD_MAX_HEAP_USED_BYTES,
  startupPortConflictExitCode: STARTUP_PORT_CONFLICT_EXIT_CODE,
  sessions,
  connections,
  mirrors,
  server,
  wss,
  logTimePrefix,
  shutdownTerminalSessions: (sessionsMap, reason) => {
    for (const session of sessionsMap.values()) {
      if (session.transport && session.closeTransport) {
        session.closeTransport(reason);
      }
    }
    sessionsMap.clear();
  },
  detachSubscriberTransportOnly: terminalRuntime.detachSubscriberTransportOnly,
  destroyMirror: terminalRuntime.destroyMirror,
  disposeScheduleRuntime: () => terminalScheduleRuntime.dispose(),
  startRelayHostClient: () => relayHostClient.start(),
  disposeRelayHostClient: () => relayHostClient.dispose(),
  disposeRtcBridgeServer: () => rtcBridgeServer.dispose()
});
var {
  extractAuthToken,
  startHeartbeatLoop,
  startMemoryGuardLoop,
  shutdownDaemon,
  handleDaemonServerClosed,
  handleDaemonServerError,
  handleDaemonServerListening
} = terminalDaemonRuntime;
var terminalBridgeRuntime = createTerminalBridgeRuntime({
  requiredAuthToken: REQUIRED_AUTH_TOKEN,
  sessions,
  connections,
  wss,
  logTimePrefix,
  extractAuthToken,
  resolveRequestOrigin: (request) => terminalHttpRuntime.resolveRequestOrigin(request),
  createWebSocketSessionTransport,
  createRtcSessionTransport,
  createTransportConnection,
  detachSubscriberTransportOnly: terminalRuntime.detachSubscriberTransportOnly,
  refreshAdaptiveWidthLeaseHeartbeat: terminalRuntime.refreshAdaptiveWidthLeaseHeartbeat,
  handleMessage: (connection, rawData, isBinary) => terminalMessageRuntime.handleMessage(connection, rawData, isBinary)
});
var {
  rtcBridgeServer,
  handleWebSocketConnection,
  handleServerUpgrade,
  handleRelaySignal,
  closeRelayPeer
} = terminalBridgeRuntime;
var relayHostClient = createTraversalRelayHostClient({
  config: DAEMON_CONFIG.relay,
  handleRelaySignal,
  closeRelayPeer,
  listTmuxSessions
});
wss.on("connection", handleWebSocketConnection);
startHeartbeatLoop();
startMemoryGuardLoop();
wss.on("close", () => {
  handleDaemonServerClosed();
});
server.on("error", (error) => {
  handleDaemonServerError(error);
});
server.on("upgrade", handleServerUpgrade);
server.listen(PORT, HOST, () => {
  handleDaemonServerListening();
});
process.on("SIGINT", () => shutdownDaemon("SIGINT", 0));
process.on("SIGTERM", () => shutdownDaemon("SIGTERM", 0));
process.on("SIGHUP", () => shutdownDaemon("SIGHUP", 0));
