// SPDX-FileCopyrightText: 2020 Aleksandr Mezin <mezin.alexander@gmail.com>
// SPDX-FileContributor: Juan M. Cruz-Martinez
// SPDX-FileContributor: Jackson Goode
//
// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';

import Gettext from 'gettext';

import { TerminalSettings } from './terminalsettings.js';
import { Notebook } from './notebook.js';
import { DisplayConfig, LayoutMode } from '../util/displayconfig.js';

const WINDOW_POS_TO_RESIZE_EDGE = {
    top: Gdk.WindowEdge.SOUTH,
    bottom: Gdk.WindowEdge.NORTH,
    left: Gdk.WindowEdge.EAST,
    right: Gdk.WindowEdge.WEST,
};

function make_resizer(orientation) {
    const box = new Gtk.EventBox({ visible: true });

    new Gtk.Separator({
        visible: true,
        orientation,
        parent: box,
        margin_top: orientation === Gtk.Orientation.HORIZONTAL ? 2 : 0,
        margin_bottom: orientation === Gtk.Orientation.HORIZONTAL ? 2 : 0,
        margin_start: orientation === Gtk.Orientation.VERTICAL ? 2 : 0,
        margin_end: orientation === Gtk.Orientation.VERTICAL ? 2 : 0,
    });

    box.connect('realize', () => {
        box.window.cursor = Gdk.Cursor.new_from_name(
            box.get_display(),
            orientation === Gtk.Orientation.VERTICAL ? 'ew-resize' : 'ns-resize'
        );
    });

    return box;
}

export const AppWindow = GObject.registerClass({
    Properties: {
        'settings': GObject.ParamSpec.object(
            'settings',
            null,
            null,
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
            Gio.Settings
        ),
        'terminal-settings': GObject.ParamSpec.object(
            'terminal-settings',
            null,
            null,
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
            TerminalSettings
        ),
        'extension-dbus': GObject.ParamSpec.object(
            'extension-dbus',
            null,
            null,
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
            Gio.DBusProxy
        ),
        'display-config': GObject.ParamSpec.object(
            'display-config',
            null,
            null,
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
            DisplayConfig
        ),
        'resize-handle': GObject.ParamSpec.boolean(
            'resize-handle',
            null,
            null,
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.EXPLICIT_NOTIFY,
            true
        ),
        'resize-edge': GObject.ParamSpec.enum(
            'resize-edge',
            null,
            null,
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.EXPLICIT_NOTIFY,
            Gdk.WindowEdge,
            Gdk.WindowEdge.SOUTH
        ),
        'tab-label-width': GObject.ParamSpec.double(
            'tab-label-width',
            null,
            null,
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.EXPLICIT_NOTIFY,
            0.0,
            0.5,
            0.1
        ),
        'tab-show-shortcuts': GObject.ParamSpec.boolean(
            'tab-show-shortcuts',
            null,
            null,
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.EXPLICIT_NOTIFY,
            true
        ),
        'active-notebook': GObject.ParamSpec.object(
            'active-notebook',
            null,
            null,
            GObject.ParamFlags.READABLE,
            Notebook
        ),
        'is-empty': GObject.ParamSpec.boolean(
            'is-empty',
            null,
            null,
            GObject.ParamFlags.READABLE,
            false
        ),
        'is-split': GObject.ParamSpec.boolean(
            'is-split',
            null,
            null,
            GObject.ParamFlags.READABLE,
            false
        ),
    },
    Signals: {
        'session-update': {},
    },
},
class DDTermAppWindow extends Gtk.ApplicationWindow {
    _init(params) {
        super._init({
            title: Gettext.gettext('ddterm'),
            icon_name: 'utilities-terminal',
            window_position: Gtk.WindowPosition.CENTER,
            ...params,
        });

        const menu_url =
            GLib.Uri.resolve_relative(import.meta.url, './ui/menus.ui', GLib.UriFlags.NONE);

        const [menu_path] = GLib.filename_from_uri(menu_url);

        this.menus = Gtk.Builder.new_from_file(menu_path);

        this._grid = new Gtk.Grid({
            parent: this,
            visible: true,
        });

        this._notebook = this._create_notebook();
        this._notebook.visible = true;
        this._notebook.hexpand = true;
        this._notebook.vexpand = true;
        this._grid.attach(this._notebook, 1, 1, 1, 1);

        this._window_title_binding = null;
        this._deserializing = false;
        this._connect_focus_tracking();

        this.connect('destroy', () => {
            this._window_title_binding?.unbind();
            this._window_title_binding = null;
        });

        this.connect('notify::tab-label-width', this.update_tab_label_width.bind(this));
        this.connect('configure-event', this.update_tab_label_width.bind(this));
        this.update_tab_label_width();

        this.settings.bind(
            'tab-label-width',
            this,
            'tab-label-width',
            Gio.SettingsBindFlags.GET
        );

        const add_resize_box = (edge, x, y, orientation) => {
            const box = make_resizer(orientation);
            box.connect('button-press-event', this.start_resizing.bind(this, edge));
            this._grid.attach(box, x, y, 1, 1);

            const update_visible = () => {
                box.visible = this.resize_handle && this.resize_edge === edge;
            };

            this.connect('notify::resize-handle', update_visible);
            this.connect('notify::resize-edge', update_visible);
            update_visible();
        };

        add_resize_box(Gdk.WindowEdge.SOUTH, 1, 2, Gtk.Orientation.HORIZONTAL);
        add_resize_box(Gdk.WindowEdge.NORTH, 1, 0, Gtk.Orientation.HORIZONTAL);
        add_resize_box(Gdk.WindowEdge.EAST, 2, 1, Gtk.Orientation.VERTICAL);
        add_resize_box(Gdk.WindowEdge.WEST, 0, 1, Gtk.Orientation.VERTICAL);

        this.settings.bind(
            'window-resizable',
            this,
            'resize-handle',
            Gio.SettingsBindFlags.GET
        );

        const edge_handler = this.settings.connect('changed::window-position', () => {
            this.update_window_pos();
        });
        this.connect('destroy', () => this.settings.disconnect(edge_handler));
        this.update_window_pos();

        this.connect('notify::screen', () => this.update_visual());
        this.update_visual();

        this.draw_handler = null;
        this.connect('notify::app-paintable', this.setup_draw_handler.bind(this));
        this.setup_draw_handler();

        this.settings.bind(
            'transparent-background',
            this,
            'app-paintable',
            Gio.SettingsBindFlags.GET
        );

        const HEIGHT_MOD = 0.05;
        const OPACITY_MOD = 0.05;

        const actions = {
            'toggle': this.toggle.bind(this),
            'show': () => this.present(),
            'hide': () => this.hide(),
            'window-size-dec': () => {
                if (this.settings.get_boolean('window-maximize'))
                    this.settings.set_double('window-size', 1.0 - HEIGHT_MOD);
                else
                    this.adjust_double_setting('window-size', -HEIGHT_MOD);
            },
            'window-size-inc': () => {
                if (!this.settings.get_boolean('window-maximize'))
                    this.adjust_double_setting('window-size', HEIGHT_MOD);
            },
            'background-opacity-dec': () => {
                this.adjust_double_setting('background-opacity', -OPACITY_MOD);
            },
            'background-opacity-inc': () => {
                this.adjust_double_setting('background-opacity', OPACITY_MOD);
            },
            'split-position-inc': () => {
                this._current_tab_container()?.adjust_split_position(0.1);
            },
            'split-position-dec': () => {
                this._current_tab_container()?.adjust_split_position(-0.1);
            },
            'focus-other-pane': () => {
                this._current_tab_container()?.focus_adjacent_terminal(1);
            },
            'focus-next-pane': () => {
                this._current_tab_container()?.focus_adjacent_terminal(1);
            },
            'focus-prev-pane': () => {
                this._current_tab_container()?.focus_adjacent_terminal(-1);
            },
            'close-pane': () => {
                this._current_tab_container()?.close_active_terminal();
            },
        };

        for (const [name, activate] of Object.entries(actions)) {
            const action = new Gio.SimpleAction({ name });
            action.connect('activate', activate);
            this.add_action(action);
        }

        ['split-position-inc', 'split-position-dec', 'focus-other-pane',
            'focus-next-pane', 'focus-prev-pane', 'close-pane'].map(
            key => this.lookup_action(key)
        ).forEach(action => {
            this.bind_property('is-split', action, 'enabled', GObject.BindingFlags.SYNC_CREATE);
        });

        this.settings.bind(
            'window-skip-taskbar',
            this,
            'skip-taskbar-hint',
            Gio.SettingsBindFlags.GET
        );

        this.settings.bind(
            'window-skip-taskbar',
            this,
            'skip-pager-hint',
            Gio.SettingsBindFlags.GET
        );

        this.settings.bind(
            'tab-show-shortcuts',
            this,
            'tab-show-shortcuts',
            Gio.SettingsBindFlags.GET
        );

        this.connect('notify::tab-show-shortcuts', () => this.update_show_shortcuts());
        this.update_show_shortcuts();

        this.connect('notify::is-empty', () => {
            if (this.is_empty)
                this.close();
        });

        this._hide_on_close();
        this._setup_size_sync();
    }

    _hide_on_close() {
        this.connect('delete-event', () => {
            if (this.is_empty)
                return false;

            this.hide();
            return true;
        });
    }

    _setup_size_sync() {
        const display = this.get_display();

        if (display.constructor.$gtype.name !== 'GdkWaylandDisplay')
            return;

        const sync_if_hidden = () => {
            if (!this.is_visible())
                this.sync_size_with_extension();
        };

        const display_config_handler =
            this.display_config.connect('notify::layout-mode', sync_if_hidden);

        this.connect('destroy', () => this.display_config.disconnect(display_config_handler));

        const dbus_handler = this.extension_dbus.connect('g-properties-changed', sync_if_hidden);
        this.connect('destroy', () => this.extension_dbus.disconnect(dbus_handler));

        const settings_handler = this.settings.connect('changed::window-maximize', sync_if_hidden);
        this.connect('destroy', () => this.settings.disconnect(settings_handler));

        this.connect('notify::is-maximized', sync_if_hidden);

        this.connect('unmap-event', () => {
            this.sync_size_with_extension();
        });

        this.sync_size_with_extension();
    }

    _connect_focus_tracking() {
        this._notebook.connect('switch-page', () => {
            this._update_window_title();
            this._notify_structure_changed();
        });

        this._notebook.connect('set-focus-child', () => {
            this._update_window_title();
        });

        this._update_window_title();
    }

    _update_window_title() {
        this._window_title_binding?.unbind();
        this._window_title_binding = null;

        this._window_title_binding = this._notebook.bind_property(
            'current-title',
            this,
            'title',
            GObject.BindingFlags.SYNC_CREATE
        );
    }

    _create_notebook() {
        const notebook = new Notebook({
            terminal_settings: this.terminal_settings,
            scrollable: true,
            group_name: 'ddtermnotebook',
            menus: this.menus,
        });

        notebook.connect('page-added', () => {
            if (!this._deserializing)
                this._notify_structure_changed();
        });

        notebook.connect('page-removed', () => {
            if (this._deserializing)
                return;

            this._notify_structure_changed();
        });

        this.settings.bind(
            'new-tab-button',
            notebook,
            'show-new-tab-button',
            Gio.SettingsBindFlags.GET
        );

        this.settings.bind(
            'new-tab-front-button',
            notebook,
            'show-new-tab-front-button',
            Gio.SettingsBindFlags.GET
        );

        this.settings.bind(
            'tab-switcher-popup',
            notebook,
            'show-tab-switch-popup',
            Gio.SettingsBindFlags.GET
        );

        this.settings.bind(
            'tab-policy',
            notebook,
            'tab-policy',
            Gio.SettingsBindFlags.GET
        );

        this.settings.bind(
            'tab-position',
            notebook,
            'tab-pos',
            Gio.SettingsBindFlags.GET
        );

        this.settings.bind(
            'tab-expand',
            notebook,
            'tab-expand',
            Gio.SettingsBindFlags.GET
        );

        this.settings.bind(
            'notebook-border',
            notebook,
            'show-border',
            Gio.SettingsBindFlags.GET
        );

        this.settings.bind(
            'tab-label-ellipsize-mode',
            notebook,
            'tab-label-ellipsize-mode',
            Gio.SettingsBindFlags.GET
        );

        this.settings.bind(
            'tab-close-buttons',
            notebook,
            'tab-close-buttons',
            Gio.SettingsBindFlags.GET
        );

        notebook.connect('session-update', () => {
            this.emit('session-update');
        });

        return notebook;
    }

    _notify_structure_changed() {
        this.freeze_notify();
        this.notify('is-empty');
        this.notify('is-split');
        this.notify('active-notebook');
        this.thaw_notify();
        this.emit('session-update');
    }

    _current_tab_container() {
        return this._notebook.current_child ?? null;
    }

    setup_draw_handler() {
        if (this.app_paintable) {
            if (!this.draw_handler)
                this.draw_handler = this.connect('draw', this.draw.bind(this));
        } else if (this.draw_handler) {
            this.disconnect(this.draw_handler);
            this.draw_handler = null;
        }

        this.queue_draw();
    }

    adjust_double_setting(name, difference, min = 0.0, max = 1.0) {
        const current = this.settings.get_double(name);
        const new_setting = current + difference;
        this.settings.set_double(name, Math.min(Math.max(new_setting, min), max));
    }

    toggle() {
        if (this.is_visible())
            this.hide();
        else
            this.present();
    }

    start_resizing(edge, source, event) {
        const [button_ok, button] = event.get_button();
        if (!button_ok || button !== Gdk.BUTTON_PRIMARY)
            return;

        const [coords_ok, x_root, y_root] = event.get_root_coords();
        if (!coords_ok)
            return;

        this.window.begin_resize_drag_for_device(
            edge,
            event.get_device(),
            button,
            x_root,
            y_root,
            event.get_time()
        );
    }

    update_visual() {
        const visual = this.screen.get_rgba_visual();

        if (visual)
            this.set_visual(visual);
    }

    draw(_widget, cr) {
        try {
            if (!this.app_paintable)
                return false;

            if (!Gtk.cairo_should_draw_window(cr, this.window))
                return false;

            const context = this.get_style_context();
            const allocation = this.get_child().get_allocation();
            Gtk.render_background(
                context, cr, allocation.x, allocation.y, allocation.width, allocation.height
            );
            Gtk.render_frame(
                context, cr, allocation.x, allocation.y, allocation.width, allocation.height
            );
        } finally {
            cr.$dispose();
        }

        return false;
    }

    sync_size_with_extension() {
        if (this.is_maximized) {
            if (this.settings.get_boolean('window-maximize'))
                return;

            this.unmaximize();
        }

        const rect = this.extension_dbus.get_cached_property('TargetRect');

        if (!rect)
            return;

        let target_w = rect.get_child_value(2).get_int32();
        let target_h = rect.get_child_value(3).get_int32();

        if (this.display_config.layout_mode !== LayoutMode.LOGICAL) {
            const scale = this.extension_dbus.get_cached_property('TargetMonitorScale');

            if (!scale)
                return;

            const scale_unpacked = scale.get_double();

            target_w = Math.floor(target_w / scale_unpacked);
            target_h = Math.floor(target_h / scale_unpacked);
        }

        this.resize(target_w, target_h);
        this.window?.resize(target_w, target_h);
    }

    update_tab_label_width() {
        const [width] = this.get_size();
        const tab_label_width = Math.floor(this.tab_label_width * width);

        this._notebook.tab_label_width = tab_label_width;
    }

    get active_notebook() {
        return this._notebook;
    }

    get is_empty() {
        return this._notebook.get_n_pages() === 0;
    }

    get is_split() {
        const container = this._current_tab_container();
        return container?.is_split ?? false;
    }

    update_window_pos() {
        const pos = this.settings.get_string('window-position');

        this.resize_edge = WINDOW_POS_TO_RESIZE_EDGE[pos];
    }

    update_show_shortcuts() {
        this._notebook.tab_show_shortcuts = this.tab_show_shortcuts;
    }

    vfunc_grab_focus() {
        this._notebook.grab_focus();
    }

    serialize_state() {
        if (this.is_empty)
            return null;

        const properties = GLib.VariantDict.new(null);
        properties.insert_value('notebook1', this._notebook.serialize_state());
        return properties.end();
    }

    deserialize_state(variant) {
        this._deserializing = true;

        try {
            this._deserialize_state_impl(variant);
        } finally {
            this._deserializing = false;
        }

        this._notify_structure_changed();
    }

    _deserialize_state_impl(variant) {
        const dict = GLib.VariantDict.new(variant);
        const variant_dict_type = new GLib.VariantType('a{sv}');

        // Check for new format first (notebook1 with pages array)
        const notebook1_data = dict.lookup_value('notebook1', variant_dict_type);

        if (notebook1_data) {
            this._notebook.deserialize_state(notebook1_data);

            // Legacy: if there was a notebook2, flatten its tabs into the notebook
            const notebook2_data = dict.lookup_value('notebook2', variant_dict_type);
            if (notebook2_data)
                this._notebook.deserialize_state(notebook2_data);
        } else {
            // Legacy tree format: type === 'split' at root level
            const type = dict.lookup('type', 's');
            if (type === 'split')
                this._deserialize_legacy_split(variant);
        }
    }

    _deserialize_legacy_split(variant) {
        const dict = GLib.VariantDict.new(variant);
        const variant_dict_type = new GLib.VariantType('a{sv}');
        const first_data = dict.lookup_value('first', variant_dict_type);
        const second_data = dict.lookup_value('second', variant_dict_type);

        if (first_data)
            this._deserialize_legacy_node(first_data);

        if (second_data)
            this._deserialize_legacy_node(second_data);
    }

    _deserialize_legacy_node(variant) {
        const dict = GLib.VariantDict.new(variant);
        const type = dict.lookup('type', 's');

        if (type === 'split') {
            this._deserialize_legacy_split(variant);
        } else if (type === 'notebook') {
            // Old format: notebook state (pages, current-page) is in the same variant
            this._notebook.deserialize_state(variant);
        }
    }

    ensure_terminal() {
        if (this.is_empty)
            this._notebook.new_page().spawn();
    }
});
