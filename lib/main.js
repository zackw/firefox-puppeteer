// Firefox Puppeteer: main loop.
// Copyright 2014 Zack Weinberg.
// Somewhat based on MozRepl by Ethan, Étienne Deparis, Ian Shannon,
// Luca Greco, Massimiliano Mirra, and others.
// GPLv3+ - see COPYING at top level.

'use strict';

const system = require('sdk/system');
const { open } = require('sdk/io/file');

const { ZmqSocket } = require('./zeromq');

let control_socket = null;
let control_log = null;
let watchdog_ticks = false;
let msg_sequence = 0;
let client_id = "";

function recv_message(data) {
    send_message("more");
}

function send_message(status, data) {
    if (data === null || data === undefined) {
        data = {};
    }
    data.status = status;
    data.client_id = client_id;
    data.sequence = msg_sequence;
    console.debug("puppet: send", data)
    if (control_log !== null)
        control_log.write("send: " + JSON.stringify(data, null, 2) + "\n")
    if (watchdog_ticks)
        dump("^");
    control_socket.write(data);
}

function on_data(data) {
    console.debug("puppet: recv", data)
    if (control_log !== null)
        control_log.write("recv: " + JSON.stringify(data, null, 2) + "\n");
    if (watchdog_ticks)
        dump(".");

    if (data.length === 1 && "client_id" in data[0] && "sequence" in data[0] &&
        data[0].client_id === client_id && data[0].sequence === msg_sequence)
    {
        msg_sequence++;
        recv_message(data[0]);
    }
    else
    {
        on_error("message ill-formed, out of sequence, or for wrong client: " +
                 JSON.stringify(data, null, 2));
    }
}

function on_connect() {
    console.debug("puppet: connected")
    if (control_log !== null)
        control_log.write("--connected to localhost:" +
                          system.env.PUPPETEER_SOCKET + "--\n");

    if (watchdog_ticks)
        dump("+");
    send_message("hello");
}

function on_error(err) {
    console.error("puppet: network error");
    console.exception(err);
    if (control_log !== null) {
        control_log.write("error: " + err + "\n");
        control_log.close();
    }
    system.exit(1);
}

function on_close() {
    console.warn("puppet: control socket closed, exiting");
    if (control_log !== null) {
        control_log.write("--EOF--\n");
        control_log.close();
    }
    system.exit(1);
}

exports.main = function main(options, callbacks) {
    if ('PUPPETEER_SOCKET' in system.env) {

        if ('PUPPETEER_CLIENT_ID' in system.env)
            client_id = system.env.PUPPETEER_CLIENT_ID;

        if ('PUPPETEER_LOG' in system.env)
            control_log = open(system.env.PUPPETEER_LOG, "w");

        if ('PUPPETEER_WATCHDOG' in system.env)
            watchdog_ticks = true;

        let port = system.env.PUPPETEER_SOCKET;
        console.info("puppet: connecting to controller at localhost:" + port);

        control_socket = new ZmqSocket({ port: port });
        control_socket.on('connect', on_connect);
        control_socket.on('data', on_data);
        control_socket.on('error', on_error);
        control_socket.on('close', on_close);
    } else {
        console.info("puppet: no control socket, inactivated");
    }
};

exports.onUnload = function onUnload (reason) {
    if (control_socket !== null) {
        control_socket.close();
        control_socket = null;
    }
};
