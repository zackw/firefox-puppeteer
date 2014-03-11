// Raw socket module for Jetpack extensions.
// Copyright 2014 Zack Weinberg.
//
// Based on the port of the node 'net' module to Jetpack by Irakli
// Gozalishvili, copyright 2011, originally MIT-licensed, with further
// cribbing from the experimental io.stream module in the Addon SDK and
// TCPSocket.js in Firefox core, both MPL.
//
// This version is GPLv3+ - see COPYING at top level.
//
// API lacunae:
// Only client TCP sockets are implemented.
// createConnection() is not provided.
// Sockets produce Uint8Array objects upon read, and accept any sort of
// ArrayBuffer(View) object for write; no conversion whatsoever is done;
// all encoding-related properties and methods are absent.
// Flow control methods are not provided.
// end() and the 'end' event are not provided because
// nsISocketTransport does not expose half-closes (NSPR has
// PR_Shutdown, but it's not reflected into netwerk _at all_ AFAICT).
//
// API changes relative to node:
// both the Socket constructor and the connect method take an options
// dictionary (which includes 'port' and 'host' keys) rather than
// positional port and host arguments.

'use strict';

const { Class }       = require('sdk/core/heritage');
const { ns }          = require('sdk/core/namespace')
const { emit }        = require('sdk/event/core');
const { EventTarget } = require('sdk/event/target');
const { merge }       = require('sdk/util/object');

const { Cc, Ci, CC, components } = require('chrome');

const createTransport =
    Cc['@mozilla.org/network/socket-transport-service;1'].
    getService(Ci.nsISocketTransportService).
    createTransport;

const socketEventTarget =
    Cc['@mozilla.org/network/socket-transport-service;1'].
    getService(Ci.nsIEventTarget);

const threadManager =
    Cc['@mozilla.org/thread-manager;1'].getService(Ci.nsIThreadManager);

// These are used for the input side of the socket.
const InputStreamPump = CC('@mozilla.org/network/input-stream-pump;1',
                           'nsIInputStreamPump', 'init');
const BinaryInputStream = CC('@mozilla.org/binaryinputstream;1',
                             'nsIBinaryInputStream', 'setInputStream');

// Despite the names, these are used for the _output_ side of the socket.
const AsyncStreamCopier = CC("@mozilla.org/network/async-stream-copier;1",
                             "nsIAsyncStreamCopier", "init");
const MultiplexInputStream = CC("@mozilla.org/io/multiplex-input-stream;1",
                                "nsIMultiplexInputStream");
const ArrayBufferInputStream = CC("@mozilla.org/io/arraybuffer-input-stream;1",
                                  "nsIArrayBufferInputStream");

const { STATUS_CONNECTED_TO } = Ci.nsISocketTransport;

const CONNECTING = 'opening';
const OPEN  = 'open';
const CLOSED = 'closed';
const READ = 'readOnly';
const WRITE = 'writeOnly';

let _ = ns();

const Socket = Class({
    extends: EventTarget,

    get readable() { return _(this).readable; },
    get writable() { return _(this).writable; },
    get readyState() {
        let _this = _(this);
        if (_this.connecting) return CONNECTING;
        else if (_this.readable && _this.writable) return OPEN;
        else if (_this.readable && !_this.writable) return READ;
        else if (!_this.readable && _this.writable) return WRITE;
        else return CLOSED;
    },
    get remoteAddress() {
        let _this = _(this);
        if ('transport' in _this && !_this.connecting) {
            let { host, port } = _this.transport;
            return host + ':' + port;
        }
        return null;
    },

    initialize: function initialize (options) {
        // defaults:
        this.host = null;
        this.port = null;
        this.proxy = null;

        EventTarget.prototype.initialize.call(this, options);
        merge(this, options);

        let _this = _(this);
        _this.readable = false;
        _this.writable = false;
        _this.connecting = false;
        _this.drained = true;

        if (this.host !== null && this.port !== null)
            this.do_connect();
    },
    connect: function connect (options) {
        merge(this, options);
        this.do_connect();
    },
    do_connect: function do_connect () {
        let _this = _(this);
        if ('transport' in _this)
            throw "Already connected";

        let transport = createTransport(null, 0,
                                        this.host, this.port, this.proxy);
        let asyncInputStream = transport.openInputStream(null, 0, 0);
        let binaryInputStream = BinaryInputStream(asyncInputStream);
        let pump = InputStreamPump(asyncInputStream, -1, -1, 0, 0, false);

        let asyncOutputStream = transport.openOutputStream(null, 0, 0);
        let outputQueue = MultiplexInputStream();
        let copier = AsyncStreamCopier(outputQueue,
                                       asyncOutputStream,
                                       socketEventTarget,
                                       true,   // yes readSegments
                                       false,  // no writeSegments
                                       null,   // default buffer size
                                       false,  // do not close input
                                       false); // do not close output

        // these are not just option dictionaries, they have to stick
        // around and not get GCed or we'll crash
        _this.eventSink = {
            onTransportStatus: this.onTransportStatus.bind(this)
        };
        _this.streamListener = {
            onStartRequest: function () {},
            onDataAvailable: this.onDataAvailable.bind(this),
            onStopRequest: this.onStopRequest_in.bind(this)
        };
        _this.outputObserver = {
            onStopRequest: this.onStopRequest_out.bind(this)
        };

        transport.setEventSink(_this.eventSink, threadManager.currentThread);
        pump.asyncRead(_this.streamListener, null);

        _this.transport  = transport;

        _this.asyncIn    = asyncInputStream;
        _this.input      = binaryInputStream;
        _this.pump       = pump;

        _this.asyncOut   = asyncOutputStream;
        _this.output     = outputQueue;
        _this.copier     = copier;

        _this.connecting = true;
    },

    onTransportStatus: function onTransportStatus (transport,
                                                   status,
                                                   progress,
                                                   total) {
        let previous = this.readyState;
        console.log("socket ("+previous+"): onTransportStatus", status);
        if (status !== STATUS_CONNECTED_TO)
            return;

        if (previous !== CONNECTING) {
            console.log("Received STATUS_CONNECTED_TO notification in state",
                        previous);
            return;
        }

        let _this = _(this);
        _this.connecting = false;
        _this.readable = true;
        _this.writable = true;
        emit(this, 'connect');
    },

    onDataAvailable: function onDataAvailable (req, c, is, offset, count) {
        let state = this.readyState;
        console.log("socket ("+state+"): onDataAvailable: ", count);

        // Sometimes we don't get an onTransportStatus notification;
        // if we get here in CONNECTING state, synthesize one.
        if (state === CONNECTING) {
            console.log("onDataAvailable before STATUS_CONNECTED_TO?!");
            this.onTransportStatus(null, STATUS_CONNECTED_TO, 0, 0);
        }

        let _this = _(this);
        try {
            let buffer = ArrayBuffer(count);
            _this.input.readArrayBuffer(count, buffer);
            emit(this, 'data', Uint8Array(buffer));
        } catch (e) {
            emit(this, 'error', e);
            _this.readable = false;
        }
    },

    onStopRequest_in: function onStopRequest_in (r, c, status) {
        _(this).readable = false;
        if (!components.isSuccessCode(status)) {
            emit(this, 'error', components.Exception("read", status));
        } else {
            emit(this, 'end');
        }
    },

    onStopRequest_out: function onStopRequest_out (r, c, status) {
        let _this = _(this);
        _this.drained = true;
        _this.output.removeStream(0);

        if (!components.isSuccessCode(status))
            emit(this, "error", components.Exception("write", status));

        else if (_this.output.count)
            this.flush();

        else if (_this.writable)
            emit(this, "drain");
    },

    write: function write(buffer) {
        let _this = _(this);
        if (!_this.writable)
            throw "stream is not writable";

        if (ArrayBuffer.isView(buffer))
            buffer = buffer.buffer;

        let chunk = ArrayBufferInputStream();
        chunk.setData(buffer, 0, buffer.byteLength);
        _this.output.appendStream(chunk);
        this.flush();
        return _this.drained;
    },

    flush: function flush() {
        let _this = _(this);
        if (_this.drained) {
            _this.drained = false;
            _this.copier.asyncCopy(_this.outputObserver, null);
        }
    },

    destroy: function destroy() {
        let _this = _(this);
        _this.readable = false;
        _this.writable = false;
        try {
            emit(this, 'close')
            _this.pump.cancel(0);
            _this.input.close();
            _this.asyncIn.close();

            _this.copier.cancel(0);
            _this.output.close();
            _this.asyncOut.flush();
            _this.asyncOut.close();

            _this.transport.close();

            delete _this.pump;
            delete _this.input;
            delete _this.asyncIn;
            delete _this.output;
            delete _this.transport;
        } catch (e) {
            emit(this, 'error', e);
        }
    }
});

exports.Socket     = Socket;
exports.CONNECTING = CONNECTING;
exports.OPEN       = OPEN;
exports.CLOSED     = CLOSED;
exports.READ       = READ;
exports.WRITE      = WRITE;
