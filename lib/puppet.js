// Firefox Puppeteer: control script - to - framework API.
// Copyright 2014 Zack Weinberg.
// Somewhat based on MozRepl by Ethan, Étienne Deparis, Ian Shannon,
// Luca Greco, Massimiliano Mirra, and others.
// GPLv3+ - see COPYING at top level.

'use strict';

const system     = require('sdk/system');
const promise    = require('sdk/core/promise');
const sandbox    = require('sdk/loader/sandbox');
const { extend } = require('sdk/util/object');
const { setTimeout,
        clearTimeout } = require('sdk/timers');

const skeleton = require('./script-skeleton');

// Built-in actions

function do_quit (deferred, options) {
    system.exit(0);
}

let script_exports = {};
let control_scripts = [];

function do_script (deferred, options) {
    let label = "puppeteer/control-script-" + (control_scripts.length + 1);
    let proto = Object.freeze(extend(skeleton, {
        exports: {},
        puppet: script_exports,
        module: Object.freeze({ id: label })
    }));
    let env = sandbox.sandbox(null, {
        sandboxName: label,
        sandboxPrototype: proto,
        wantComponents: false
    });

    sandbox.evaluate(env, options.script, label);
    control_scripts.push(env);
    proto.exports.initialize(deferred, options);
}

// Action dispatcher

let action_timeout = 60 * 1000; // one minute default

let actions = {
    "script": do_script,
    "quit": do_quit
};

function timeout(promise, ms) {
    let deferred = defer();
    let timeout = setTimeout(function () {
        deferred.reject(Error("" +ms+ "ms timeout expired"))
    }, ms);
    promise.then(function (...args) {
        clearTimeout(timeout);
        deferred.resolve(...args);
    }, function (...args) {
        clearTimeout(timeout);
        deferred.reject(...args);
    });
    return deferred.promise;
}

// Entry point for the code that talks to the network.
exports.dispatch =
function dispatch(options) {
    let deferred = defer();
    try {
        actions[options.action](deferred, options);
        // you get one minute
        return timeout(deferred.promise, 60 * 1000);
    } catch (e) {
        deferred.reject(e);
        return deferred.promise;
    }
}

// API available to control scripts

script_exports.add_actions =
function add_actions (acts) {
    for (let verb of Object.getOwnPropertyNames(acts)) {
        // you may not override "script" or "quit"
        if (verb !== "script" && verb !== "quit") {
            actions[verb] = acts[verb];
        }
    }
}

script_exports.remove_actions =
function remove_actions (acts) {
    for (let verb of acts) {
        // you may not override "script" or "quit"
        if (verb !== "script" && verb !== "quit") {
            delete actions[verb];
        }
    }
}

script_exports.set_action_timeout =
function set_action_timeout (ms) {
    action_timeout = ms;
}

Object.freeze(script_exports);
