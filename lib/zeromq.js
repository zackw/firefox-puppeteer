// ZeroMQ client module for Jetpack extensions.
// Copyright 2014 Zack Weinberg.
// Somewhat based on ZmqSocket.{js,as} by Artur Brugeman, copyright 2011.
// GPLv3+ - see COPYING at top level.
//
// Only ZMTP protocol version 2.0 is implemented;
// only REQ-type sockets, connecting to a single peer, are implemented;
// transparent reconnection is not implemented.

'use strict';

const { emit }        = require('sdk/event/core');
const { EventTarget } = require('sdk/event/target');
const { Class }       = require('sdk/core/heritage');
const { merge }       = require('sdk/util/object');
const { Socket }      = require('./socket');

let Encoder = new TextEncoder("utf-8");
let Decoder = new TextDecoder("utf-8");

// As far as I am aware this is the only way to concatenate ArrayBuffers.
// *sadface*
function append_buf(buffer1, buffer2) {
    let tmp = Uint8Array(buffer1.byteLength + buffer2.byteLength);
    tmp.set(Uint8Array(buffer1), 0);
    tmp.set(Uint8Array(buffer2), buffer1.byteLength);
    return tmp.buffer;
}

// Each ZMTP frame sent or received by this client, except for delimiter
// frames, is required to begin with a typecode byte, corresponding to
// one of Javascript's fundamental serializable types (+ "binary").
const TYPE_NULL   = 0x00;
const TYPE_UNDEF  = 0x01;
const TYPE_BINARY = 0x02;
const TYPE_BOOL   = 0x03;
const TYPE_NUMBER = 0x04;
const TYPE_STRING = 0x05;
const TYPE_OBJECT = 0x06;

const TYPE_DELIM  = 0xFF; // only for output from decode_frame

function make_delim_frame () {
    let frame = Uint8Array(2);
    frame.set(0, 0x01); // more will follow
    frame.set(1, 0x00); // length is zero
    return frame;
}

function make_frame (val, more) {
    let type, data;

    if (val === null) {
        type = TYPE_NULL;
        data = Uint8Array(0);
    } else if (val === undefined) {
        type = TYPE_UNDEF;
        data = Uint8Array(0);

    } else if (val instanceof Uint8Array) {
        type = TYPE_BINARY;
        data = val;

    } else if (val instanceof ArrayBuffer || ArrayBuffer.isView(val)) {
        type = TYPE_BINARY;
        data = Uint8Array(val);

    } else if (typeof val === 'boolean') {
        type = TYPE_BOOL;
        data = Uint8Array(1);
        data.set(0, val);

    } else if (typeof val === 'number') {
        type = TYPE_NUMBER;
        data = Uint8Array(8);
        DataView(data.buffer).setFloat64(0, val, /*little-endian=*/false);

    } else if (typeof val === 'string') {
        type = TYPE_STRING;
        data = Encoder.encode(val);

    } else {
        type = TYPE_OBJECT;
        data = Encoder.encode(JSON.stringify(val));
    }

    // DataView doesn't support 64-bit integers. Feh.
    if (data.byteLength+1 > 0xFFFFFFFF)
        throw "Frame too large for JavaScript: " + data.byteLength;

    let need_long_header = data.byteLength <= 255;
    let header_len = need_long_header ? 3 : 10;
    let frame_len = data.byteLength + header_len;
    let frame_buffer = ArrayBuffer(frame_len);
    let header = DataView(frame_buffer, 0, header_len);
    let contents = Uint8Array(frame_buffer, header_len, data.byteLength);
    let flags = ((more ? 0x01 : 0x00) | (need_long_header ? 0x02 : 0x00));

    header.setUint8(0, flags);
    if (need_long_header) {
        // DataView doesn't support 64-bit integers. Feh.
        header.setUint32(1, 0, /*little-endian=*/false);
        header.setUint32(5, data.byteLength+1, /*little-endian=*/false);
        header.setUint8(9, type);
    } else {
        header.setUint8(1, data.byteLength+1);
        header.setUint8(2, type);
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
            throw "Frame too large for JavaScript: " + hi + "|" + lo;
        frame_len = lo + 9;
    } else {
        frame_len = view.getUint8(1) + 2;
    }

    return buffer.byteLength >= frame_len ? frame_len : 0;
}

// Decode the ZMTP frame consisting of the first FRAME_LEN bytes of BUFFER.
// This performs the inverse operation to make_frame, above.  Returns a
// two-element array consisting of the 'val' and 'more' arguments to
// that function, in that order.  Note that for TYPE_BINARY, if the original
// element type was not Uint8Array, that has been lost.
function decode_frame(buffer, frame_len)
{
    if (!(buffer instanceof ArrayBuffer))
        buffer = buffer.buffer;

    if (try_get_frame_len(buffer) != frame_len)
        throw "Assertion failed: frame in buffer not of expected length";

    let view = DataView(buffer);
    let more = ((view.getUint8(0) & 0x01) == 0x01);
    let long_header = ((view.getUint8(0) & 0x02) == 0x02);
    let content_offset = long_header ? 3 : 10;

    if (frame_len == content_offset - 1) // delimiter frame
        return [TYPE_DELIM, undefined, more];

    let type = view.getUint8(content_offset - 1);
    let data = Uint8Array(buffer, content_offset, frame_len - content_offset);
    let val;

    if (type === TYPE_NULL)
        val = null;

    else if (type === TYPE_UNDEF)
        val = undefined;

    else if (type === TYPE_BINARY)
        val = data;

    else if (type === TYPE_BOOLEAN)
        val = !!data[0];

    else if (type === TYPE_NUMBER)
        val = view.getFloat64(content_offset, /*little-endian=*/false);

    else if (type === TYPE_STRING)
        val = Decoder.decode(data);

    else if (type === TYPE_OBJECT)
        val = JSON.parse(Decoder.decode(data));

    else
        throw "Unimplemented type code: " + type;

    return [val, more];
}

// The initial "greeting" sent upon connection.
function make_greeting(identity)
{
    if (identity instanceof ArrayBuffer || ArrayBuffer.isView(identity)) {
        if (!(identity instanceof Uint8Array))
            identity = Uint8Array(identity);
    } else {
        identity = Encoder.encode(identity);
    }
    if (identity.byteLength > 255)
        throw "Identity can be no more than 255 bytes";

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
    greeting[13] = message.byteLength;
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
        greeting[ 1] != 0x00 || // ...
        greeting[ 2] != 0x00 ||
        greeting[ 3] != 0x00 ||
        greeting[ 4] != 0x00 ||
        greeting[ 5] != 0x00 ||
        greeting[ 6] != 0x00 ||
        greeting[ 7] != 0x00 ||
        greeting[ 8] != 0x00 ||
        greeting[ 9] != 0x7F || // ...
        greeting[10] != 0x01 || // revision
        (greeting[11] != 0x04 && // socket-type = REP
         greeting[11] != 0x06) || // socket-type = ROUTER
        greeting[12] != 0x00) { // final-short
          throw "Invalid greeting: " + Decoder.decode(greeting.subarray(0,13));
    }

    if (buffer.byteLength < 14 + greeting[13])
        return 0;
    return 14 + greeting[13];
}

// ZMTP lifecycle states.
const ZMTP_GREETING = 0;
const ZMTP_MESSAGES = 1;
const ZMTP_CLOSING  = 2;

var ZmqSocket = Class({
    extends: EventTarget,
    initialize: function initialize (options) {
        // defaults:
        this.identity = Uint8Array(0);
        this.host     = "localhost";
        this.port     = undefined;

        EventTarget.prototype.initialize.call(this, options);
        merge(this, options);

        this.state  = ZMTP_GREETING;
        this.socket = new Socket();
        this.socket.on('connect', ZmqSocket.onConnect.bind(this));
        this.socket.on('close',   ZmqSocket.onClose.bind(this));
        this.socket.on('data',    ZmqSocket.onData.bind(this));
        this.socket.on('drain',   ZmqSocket.onDrain.bind(this));
        this.socket.on('error',   ZmqSocket.onError.bind(this));
        this.socket.on('end',     ZmqSocket.onEnd.bind(this));
        this.socket.connect(this.port, this.host);

        this.inq = ArrayBuffer();
        this.inmsg = [];
    },

    // When the socket connects, immediately transmit our own greeting.
    // Don't generate a connect event for our own listeners yet.
    onConnect: function onConnect () {
        this.socket.write(make_greeting(this.identity));
    }

    // Close fires when both ends of the connection are shut down, so
    // any opportunity to send or receive further data has been lost.
    // Similarly for error.  Technically not so for end, but a REQ
    // socket must receive a reply for each send, so it doesn't make
    // sense to transmit a reply after receiving a half-close.
    onClose: function onClose () {
        this.state = ZMTP_CLOSING;
        emit(this, 'close', this);
    },
    onError: function onError () {
        this.state = ZMTP_CLOSING;
        emit(this, 'error', this);
    },
    onEnd: function onEnd () {
        this.state = ZMTP_CLOSING;
        emit(this, 'end', this);
    },

    // On data available, copy to our own buffer.  If we have a complete
    // zmq message, decode it and relay.
    onData: function onData (packet) {
        this.inq = append_buf(this.inq, packet);
        if (this.state === ZMTP_GREETING) {
            let len = check_greeting(this.inq);
            if (!len)
                return;

            this.state = ZMTP_MESSAGES;
            emit(this, 'connect', this);
        }

        while (let len = try_get_frame_len(this.inq)) {
            let [type, val, more] = decode_frame(this.inq, len);

            if (type == TYPE_DELIM) {
                if (this.inmsg.length !== 0 || !more)
                    throw "Protocol error: DELIM not first frame in msg";
            } else {
                this.inmsg.push(val)
                if (!more) {
                    emit(this, 'data', this.inmsg);
                    this.inmsg = [];
                }
            }
            this.inq = this.inq.slice(len);
        }
    },

    onDrain: function onDrain () {
        if (this.state === ZMTP_CLOSING) {
            this.socket.end();
        }
    }

    // write can take a typed array (framed and sent as is), a string
    // (encoded to UTF-8 and framed), an object (converted to JSON,
    // encoded, and framed), or a proper Array of any of the above
    // (each entry in the array is treated as a frame).
    write: function write (message) {
        if (this.state !== ZMTP_MESSAGES)
            throw "Not connected";

        frames = [ make_delim_frame() ];

        if (Array.isArray(message)) {
            for (let i = 0; i < message.length-1; i++)
                frames.push(make_frame(message[i], true));
            frames.push(make_frame(message[message.length-1], false));
        } else {
            frames.push(make_frame(message, false));
        }

        let total_len = 0;
        for (frame of frames)
            total_len += frame.byteLength;
        let message = Uint8Array(total_len);
        let offset = 0;
        for (frame of frames) {
            message.set(frame, offset);
            offset += frame.byteLength;
        }

        this.socket.write(message);
    }

    // Close does a half-close, waiting for the reply before actually
    // closing.
    close: function close () {
        this.state = ZMTP_CLOSING;
    },
});

exports.ZmqSocket = ZmqSocket;