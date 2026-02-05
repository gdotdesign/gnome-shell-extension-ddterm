// SPDX-FileCopyrightText: 2024 Aleksandr Mezin <mezin.alexander@gmail.com>
//
// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import { Application as BaseApplication } from './application.js';
import { AppWindow } from './dev-appwindow.js';

export const Application = GObject.registerClass({
}, class DDTermDevApplication extends BaseApplication {
    _launch_service() {
        return -1;
    }

    startup() {
        try {
            super.startup();
        } catch (ex) {
            // Ignore errors from DisplayConfig requiring Mutter
            const isMutterError = ex.message?.includes('org.gnome.Mutter') ||
                ex.message?.includes('DisplayConfig');
            if (!isMutterError)
                throw ex;
        }

        // Clear the dependencies that require GNOME Shell/Mutter
        this.extension_dbus = null;
        this.display_config = null;

        // super.startup() may have thrown before setting these up
        if (!this.session_file_path) {
            this.session_file_path = GLib.build_filenamev([
                GLib.get_user_cache_dir(),
                this.application_id,
                'session',
            ]);

            this.restore_session();
        }
    }

    ensure_window() {
        if (this.window)
            return this.window;

        this.window = new AppWindow({
            application: this,
            settings: this.settings,
            terminal_settings: this.terminal_settings,
            extension_dbus: null,
            display_config: null,
        });

        this.window.connect('destroy', source => {
            if (source !== this.window)
                return;

            this.window = null;

            if (this._save_session_handler) {
                source.disconnect(this._save_session_handler);
                this._save_session_handler = null;
            }
        });

        this._save_session_handler =
            this.window.connect('session-update', this.schedule_save_session.bind(this));

        return this.window;
    }
});
