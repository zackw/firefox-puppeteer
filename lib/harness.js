// Firefox Puppeteer: browser-control harness.
// Copyright 2014 Zack Weinberg.
// Somewhat based on MozRepl by Ethan, Étienne Deparis, Ian Shannon,
// Luca Greco, Massimiliano Mirra, and others.
// GPLv3+ - see COPYING at top level.

'use strict';

const { Class }       = require('sdk/core/heritage');
const { ns }          = require('sdk/core/namespace');

const pageMod         = require('sdk/page-mod');
const tabs            = require('sdk/tabs');

const _ = ns();

const BrowserHarness = Class({
    initialize: function initialize (options) {
    },

    dispatch: function dispatch (message) {
    },

    // APIs available to sandboxed script
    h_register_action: function h_register_action (action, callback) {
    },

    h_send_reply: function h_send_reply (status, data) {
    },

    h_load_page: function h_load_page (url) {
    },
});

exports.BrowserHarness = BrowserHarness;
