// ZeroMQ client module for Jetpack extensions.
// Copyright 2014 Zack Weinberg.
// Somewhat based on ZmqSocket.{js,as} by Artur Brugeman, copyright 2011.
// GPLv3+ - see COPYING at top level.
//
// Only ZMTP protocol version 2.0 is implemented;
// only REQ-type sockets, connecting to a single peer, are implemented;
// transparent reconnection is not implemented.

'use strict';

const { Class }       = require('sdk/core/heritage');
const { ns }          = require('sdk/core/namespace');
const { emit }        = require('sdk/event/core');
const { EventTarget } = require('sdk/event/target');
const { merge }       = require('sdk/util/object');
const { TextEncoder,
        TextDecoder } = require('sdk/io/buffer');

const { Socket }      = require('./socket');

const _ = ns();
const Encoder = TextEncoder("utf-8");
const Decoder = TextDecoder("utf-8");

// As far as I am aware this is the only way to concatenate ArrayBuffers.
// *sadface*
function append_buf(buffer1, buffer2) {
    let tmp = Uint8Array(buffer1.byteLength + buffer2.byteLength);
    tmp.set(Uint8Array(buffer1), 0);
    tmp.set(Uint8Array(buffer2), buffer1.byteLength);
    return tmp.buffer;
}

// As far as I am aware this has to be done manually.
// *sadface*
function buf_to_hex(buffer) {
    let rv = new Array(buffer.byteLength);
    if (ArrayBuffer.isView(buffer))
        buffer = buffer.buffer;
    buffer = DataView(buffer);
    for (let i = 0; i < buffer.byteLength; i++)
        rv[i] = ("00"+buffer.getUint8(i).toString(16)).slice(-2);
    return rv.join(" ");
}

// Generate a ZMTP delimiter frame.
function make_delim_frame () {
    let frame = Uint8Array(2);
    frame[0] = 0x01; // more will follow
    frame[1] = 0x00; // length is zero
    return frame;
}

// Generate a ZMTP frame containing the UTF-8 encoding of the JSON
// stringification of 'val'.  More frames follow if 'more' is true.
function make_data_frame (val, more) {
    let data = Encoder.encode(JSON.stringify(val));

    // DataView doesn't support 64-bit integers. Feh.
    if (data.byteLength > 0xFFFFFFFF)
        throw Error("Frame too large for JavaScript: " + data.byteLength);

    let need_long_header = data.byteLength > 255;
    let header_len = need_long_header ? 9 : 2;
    let frame_len = data.byteLength + header_len;
    let frame_buffer = ArrayBuffer(frame_len);
    let header = DataView(frame_buffer, 0, header_len);
    let contents = Uint8Array(frame_buffer, header_len, data.byteLength);
    let flags = ((more ? 0x01 : 0x00) | (need_long_header ? 0x02 : 0x00));

    header.setUint8(0, flags);
    if (need_long_header) {
        header.setUint32(1, 0, /*little-endian=*/false);
        header.setUint32(5, data.byteLength, /*little-endian=*/false);
    } else {
        header.setUint8(1, data.byteLength);
    }
    contents.set(data);

    return frame_buffer;
}

// If this buffer contains a complete ZMTP frame, returns its length
// (including the length of the header); otherwise, returns zero.
// No ZMTP frame can be fewer than two bytes long, so there is no ambiguity.
function try_get_frame_len(buffer)
{
    if (buffer.byteLength < 2)
        return 0;

    let view = DataView(buffer);
    let frame_len;
    if ((view.getUint8(0) & 0x02) == 0x02) {
        if (buffer.byteLength < 9)
            return 0;
        let hi = view.getUint32(1, /*little-endian=*/false);
        let lo = view.getUint32(5, /*little-endian=*/false);
        if (hi != 0)
            throw Error("Frame too large for JavaScript: " + hi + "|" + lo);
        frame_len = lo + 9;
    } else {
        frame_len = view.getUint8(1) + 2;
    }

    return buffer.byteLength >= frame_len ? frame_len : 0;
}

// Decode the ZMTP frame consisting of the first FRAME_LEN bytes of BUFFER.
// This performs the inverse operation to make_delim_frame/make_data_frame,
// above.  Returns a two-element array; the first entry is the encoded
// object (null for a delimiter frame, but also if null is what was encoded),
// and the second entry is a pair of booleans:
//    bit 0 true  = this is a data frame
//          false = this is a delimiter frame
//    bit 1 true  = this is a final frame
//          false = more frames to follow
function decode_frame(buffer, frame_len)
{
    if (!(buffer instanceof ArrayBuffer))
        buffer = buffer.buffer;

    if (try_get_frame_len(buffer) != frame_len)
        throw Error("Assertion failed: frame in buffer not of expected length");

    let view = DataView(buffer);
    let more = ((view.getUint8(0) & 0x01) == 0x01);
    let long_header = ((view.getUint8(0) & 0x02) == 0x02);
    let content_offset = long_header ? 9 : 2;

    if (frame_len == content_offset) // delimiter frame
        return [null, more ? 0x00 : 0x02]

    let data = Uint8Array(buffer, content_offset, frame_len - content_offset);
    let val = JSON.parse(Decoder.decode(data));

    return [val, more ? 0x01 : 0x03];
}

// The initial "greeting" sent upon connection.
function make_greeting(identity)
{
    let greeting = Uint8Array(identity.byteLength + 14);
    greeting[ 0] = 0xFF; // signature
    greeting[ 1] = 0x00; // ...
    greeting[ 2] = 0x00;
    greeting[ 3] = 0x00;
    greeting[ 4] = 0x00;
    greeting[ 5] = 0x00;
    greeting[ 6] = 0x00;
    greeting[ 7] = 0x00;
    greeting[ 8] = 0x00;
    greeting[ 9] = 0x7F; // ...
    greeting[10] = 0x01; // revision
    greeting[11] = 0x03; // socket-type = REQ
    greeting[12] = 0x00; // final-short
    greeting[13] = identity.byteLength;
    greeting.set(identity, 14);

    return greeting;
}

// Validate the peer's greeting.
// Returns 0 if more data is needed; the length of the greeting, if it
// was successful; or throws an exception.  We are a REQ socket
// connected to a single peer, so we don't care about its identity.
function check_greeting(buffer)
{
    if (buffer.byteLength < 14)
        return 0;

    let greeting = Uint8Array(buffer);
    if (greeting[ 0] != 0xFF || // signature
        // bytes 1 through 8 are supposed to be all zero in ZMTP/2 but
        // in ZMTP/1 they are a length field, so for compatibility
        // with ZMTP/2 implementations compatible with ZMTP/1
        // (not with ZMTP/1 itself), ignore them
        greeting[9] != 0x7F || // signature
        greeting[10] != 0x01 || // revision
        (greeting[11] != 0x04 && // socket-type = REP
         greeting[11] != 0x06) || // socket-type = ROUTER
        greeting[12] != 0x00) { // final-short
            throw Error("Invalid greeting: " +
                        buf_to_hex(greeting.subarray(0,13)));
    }

    if (buffer.byteLength < 14 + greeting[13])
        return 0;
    return 14 + greeting[13];
}

// ZMTP lifecycle states.
const ZMTP_GREETING = 0;
const ZMTP_MESSAGES = 1;
const ZMTP_CLOSING  = 2;
const ZMTP_CLOSED   = 3;

const ZmqSocket = Class({
    extends: EventTarget,
    initialize: function initialize (options) {
        // defaults:
        this.identity = "";
        this.host     = "localhost";
        this.port     = null;

        EventTarget.prototype.initialize.call(this, options);
        merge(this, options);

        this.identity = Encoder.encode(this.identity);
        if (this.identity.byteLength > 255)
            throw Error("Identity can be no more than 255 bytes encoded");

        // internals
        let _this = _(this);
        _this.state  = ZMTP_GREETING;
        _this.socket = new Socket();
        _this.socket.on('connect', ZmqSocket.prototype.onConnect.bind(this));
        _this.socket.on('data',    ZmqSocket.prototype.onData.bind(this));
        _this.socket.on('error',   ZmqSocket.prototype.onError.bind(this));
        _this.socket.on('close',   ZmqSocket.prototype.onClose.bind(this));
        _this.socket.on('end',     ZmqSocket.prototype.onClose.bind(this));
        _this.socket.connect({ host: this.host,
                               port: this.port });

        _this.inq = ArrayBuffer();
        _this.inmsg = [];
        console.log("zmq: connecting...");
    },

    // When the socket connects, immediately transmit our own greeting.
    // Don't generate a connect event for our own listeners yet.
    onConnect: function onConnect () {
        let greeting = make_greeting(this.identity);
        console.log("zmq: sending greeting: ", buf_to_hex(greeting))
        _(this).socket.write(greeting);
    },

    // Close fires when both ends of the connection are shut down, so
    // any opportunity to send or receive further data has been lost.
    // Similarly for error.  Technically not so for end, but a REQ
    // socket must receive a reply for each send, so it doesn't make
    // sense to transmit a reply after receiving a half-close.
    onClose: function onClose () {
        let _this = _(this);
        if (_this.inq.byteLength > 0 || _this.inmsg.length > 0) {
            console.log("zmq: incomplete ZMTP message at EOF");
            emit(this, 'error', "incomplete ZMTP message at EOF");
        }
        _this.state = ZMTP_CLOSED;
        _this.socket.destroy();
        emit(this, 'close');
    },
    onError: function onError (err) {
        console.log("zmq: socket-level error: ", err)
        emit(this, 'error', err);
        _this.state = ZMTP_CLOSED;
        _this.socket.destroy();
        emit(this, 'close');
    },

    // On data available, copy to our own buffer.  If we have a complete
    // zmq message, decode it and relay.
    onData: function onData (packet) {
        let _this = _(this);
        let len;
        console.log("zmq: received " + packet.byteLength +
                    " bytes in state " + _this.state);

        try {
            _this.inq = append_buf(_this.inq, packet);
            if (_this.state === ZMTP_GREETING) {
                let len = check_greeting(_this.inq);
                if (!len) {
                    console.log("zmq: incomplete greeting: ",
                                buf_to_hex(_this.inq));
                    return;
                }
                console.log("zmq: complete greeting: ",
                            buf_to_hex(Uint8Array(_this.inq).subarray(0, len)));
                _this.inq = _this.inq.slice(len);
                _this.state = ZMTP_MESSAGES;
                emit(this, 'connect');
            }

            while (len = try_get_frame_len(_this.inq)) {
                console.log("zmq: received frame len", len);
                let [val, flags] = decode_frame(_this.inq, len);

                let delim = !(flags & 0x01);
                let more  = !(flags & 0x02);

                console.log("zmq: received frame: ", val,
                            "(delim="+delim+", more="+more+")");

                if (delim) {
                    if (_this.inmsg.length !== 0)
                        throw Error("Protocol error: " +
                                    "DELIM not first frame in message");
                    if (!more)
                        throw Error("Protocol error: " +
                                    "DELIM-only message");
                } else {
                    _this.inmsg.push(val)
                    if (!more) {
                        console.log("zmq: complete message received");
                        emit(this, 'data', _this.inmsg);
                        _this.inmsg = [];
                    }
                }
                _this.inq = _this.inq.slice(len);
            }
        } catch (e) {
            console.log("zmq: error: ", e);
            emit(this, 'error', e);
            _this.state = ZMTP_CLOSED;
            _this.socket.destroy();
            emit(this, 'close');
        }
    },

    // write can take a typed array (framed and sent as is), a string
    // (encoded to UTF-8 and framed), an object (converted to JSON,
    // encoded, and framed), or a proper Array of any of the above
    // (each entry in the array is treated as a frame).
    write: function write (message) {
        if (_(this).state !== ZMTP_MESSAGES) {
            console.log("zmq: sending in state ", _(this).state);
            throw Error("write called when not connected");
        }

        this.write_frame(make_delim_frame());

        if (Array.isArray(message)) {
            for (let i = 0; i < message.length-1; i++)
                this.write_frame(make_data_frame(message[i], true));
            this.write_frame(make_data_frame(message[message.length-1],
                                             false));
        } else {
            this.write_frame(make_data_frame(message, false));
        }
    },

    write_frame: function write_frame (frame) {
        console.log("zmq: send frame: " + buf_to_hex(frame))
        _(this).socket.write(frame)
    },

    // Close can only make note of the half-closed-ness, because
    // we can't actually do a shutdown(SHUT_WR) - see further notes
    // in socket.js.
    close: function close () {
        _(this).state = ZMTP_CLOSING;
    },
});

exports.ZmqSocket = ZmqSocket;
