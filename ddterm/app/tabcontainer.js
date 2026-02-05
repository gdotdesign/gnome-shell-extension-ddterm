// SPDX-FileCopyrightText: 2025 Aleksandr Mezin <mezin.alexander@gmail.com>
//
// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import { SplitContainer } from './splitcontainer.js';
import { TerminalPage } from './terminalpage.js';
import { TabLabel } from './tablabel.js';
import { TerminalSettings } from './terminalsettings.js';

export const TabContentContainer = GObject.registerClass({
    Properties: {
        'terminal-settings': GObject.ParamSpec.object(
            'terminal-settings',
            null,
            null,
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
            TerminalSettings
        ),
        'menus': GObject.ParamSpec.object(
            'menus',
            null,
            null,
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
            Gtk.Builder
        ),
        'is-split': GObject.ParamSpec.boolean(
            'is-split',
            null,
            null,
            GObject.ParamFlags.READABLE,
            false
        ),
        'title': GObject.ParamSpec.string(
            'title',
            null,
            null,
            GObject.ParamFlags.READABLE,
            ''
        ),
    },
    Signals: {
        'session-update': {},
        'new-tab-before-request': {},
        'new-tab-after-request': {},
        'move-prev-request': {},
        'move-next-request': {},
    },
}, class DDTermTabContentContainer extends Gtk.Box {
    _init(params) {
        super._init({
            visible: true,
            ...params,
        });

        this._content = null;
        this._active_terminal = null;
        this._title_binding = null;
        this._restructuring = false;
        this._collapse_idle = null;
        this._destroyed = false;

        this.connect('destroy', () => {
            this._destroyed = true;

            if (this._collapse_idle) {
                GLib.Source.remove(this._collapse_idle);
                this._collapse_idle = null;
            }
        });

        this.tab_label = new TabLabel({
            visible_window: false,
            context_menu_model: this.menus.get_object('tab-popup'),
        });

        const tab_label_destroy_handler =
            this.connect('destroy', () => this.tab_label.destroy());

        this.tab_label.connect('destroy', () => {
            this.disconnect(tab_label_destroy_handler);
        });

        this.tab_label.connect('close', () => this._close_tab());

        this.connect('set-focus-child', () => {
            this._update_active_terminal();
        });
    }

    get is_split() {
        return this._content instanceof SplitContainer;
    }

    get title() {
        return this._active_terminal?.title ?? '';
    }

    get_active_terminal() {
        return this._active_terminal;
    }

    get_all_terminals() {
        if (!this._content)
            return [];

        if (this._content instanceof TerminalPage)
            return [this._content];

        if (this._content instanceof SplitContainer)
            return this._content.get_all_terminals();

        return [];
    }

    set_terminal(page) {
        this._clear_content();
        this._content = page;
        page.hexpand = true;
        page.vexpand = true;
        this.add(page);
        this._connect_terminal(page);
        this._set_active_terminal(page);
        this._update_is_split();
    }

    _create_terminal(properties = {}) {
        let working_directory = null;

        if (this.terminal_settings.preserve_working_directory)
            working_directory = this._active_terminal?.get_cwd() ?? null;

        const page = new TerminalPage({
            terminal_settings: this.terminal_settings,
            terminal_menu: this.menus.get_object('terminal-popup'),
            tab_menu: this.menus.get_object('tab-popup'),
            visible: true,
            ...properties,
            command: properties['command'] ?? this.terminal_settings.get_command(working_directory),
        });

        this._connect_terminal(page);
        return page;
    }

    _connect_terminal(page) {
        page.connect('split-horizontal-request', () => {
            this.split(page, Gtk.Orientation.HORIZONTAL);
        });

        page.connect('split-vertical-request', () => {
            this.split(page, Gtk.Orientation.VERTICAL);
        });

        page.connect('unsplit-request', () => {
            this.unsplit();
        });

        page.connect('close-pane-request', () => {
            this.close_active_terminal();
        });

        page.connect('move-to-other-pane-request', () => {
            this._handle_move_to_other_pane(page);
        });

        page.connect('session-update', () => {
            this.emit('session-update');
        });

        page.connect('new-tab-before-request', () => {
            this.emit('new-tab-before-request');
        });

        page.connect('new-tab-after-request', () => {
            this.emit('new-tab-after-request');
        });

        page.connect('move-prev-request', () => {
            this.emit('move-prev-request');
        });

        page.connect('move-next-request', () => {
            this.emit('move-next-request');
        });

        page.connect('destroy', () => {
            if (this._restructuring)
                return;

            this._on_terminal_destroyed(page);
        });
    }

    _on_terminal_destroyed(_page) {
        if (this._destroyed)
            return;

        if (!(this._content instanceof SplitContainer)) {
            // Single terminal tab — remove the whole tab
            this._content = null;
            this._set_active_terminal(null);
            this.destroy();
            return;
        }

        // Terminal was inside a split — find and collapse empty split nodes
        // Defer to idle so the widget tree is in a consistent state
        if (!this._collapse_idle) {
            this._collapse_idle = GLib.idle_add(GLib.PRIORITY_HIGH, () => {
                this._collapse_idle = null;

                if (!this._destroyed)
                    this._collapse_empty_splits();

                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _collapse_empty_splits() {
        if (!(this._content instanceof SplitContainer))
            return;

        this._restructuring = true;

        try {
            const result = this._collapse_split_recursive(this._content);

            if (!result) {
                // Everything is gone
                this._content = null;
                this._set_active_terminal(null);
                this.destroy();
                return;
            }

            if (result !== this._content) {
                // Root split was collapsed to a simpler node
                this.remove(this._content);
                this._content = result;
                result.hexpand = true;
                result.vexpand = true;
                this.add(result);
            }

            result.grab_focus();
        } finally {
            this._restructuring = false;
        }

        this._update_is_split();
        this._update_active_terminal();
        this.emit('session-update');
    }

    _collapse_split_recursive(split) {
        let child1 = split.get_child1();
        let child2 = split.get_child2();

        // Recursively collapse nested splits first
        if (child1 instanceof SplitContainer) {
            const result = this._collapse_split_recursive(child1);
            if (result !== child1) {
                if (child1.get_parent() === split)
                    split.remove(child1);

                child1 = result;
                if (child1)
                    split.pack1(child1, true, true);
            }
        }

        if (child2 instanceof SplitContainer) {
            const result = this._collapse_split_recursive(child2);
            if (result !== child2) {
                if (child2.get_parent() === split)
                    split.remove(child2);

                child2 = result;
                if (child2)
                    split.pack2(child2, true, true);
            }
        }

        // Now check what remains
        if (child1 && child2)
            return split;  // Both children present, split stays

        if (child1) {
            split.remove(child1);
            return child1;
        }

        if (child2) {
            split.remove(child2);
            return child2;
        }

        return null;  // Both children gone
    }

    split(terminal, orientation) {
        this._restructuring = true;

        try {
            const new_terminal = this._create_terminal();
            new_terminal.spawn();

            const new_split = new SplitContainer({
                orientation,
                visible: true,
            });

            new_split.connect('session-update', () => this.emit('session-update'));

            if (this._content === terminal) {
                // Splitting a single terminal
                this.remove(terminal);
                new_split.pack1(terminal, true, true);
                new_split.pack2(new_terminal, true, true);
                this._content = new_split;
                new_split.hexpand = true;
                new_split.vexpand = true;
                this.add(new_split);
            } else if (this._content instanceof SplitContainer) {
                // Splitting a terminal inside an existing split tree
                const parent_split = this._find_parent_split(terminal);
                if (parent_split) {
                    parent_split.replace_child(terminal, new_split);
                    new_split.pack1(terminal, true, true);
                    new_split.pack2(new_terminal, true, true);
                } else {
                    // Terminal is a direct child of root split — shouldn't happen
                    // but handle gracefully
                    return;
                }
            }

            new_terminal.grab_focus();
        } finally {
            this._restructuring = false;
        }

        this._update_is_split();
        this.emit('session-update');
    }

    unsplit() {
        if (!this.is_split)
            return;

        this._restructuring = true;

        try {
            const active = this._active_terminal;
            const all = this.get_all_terminals();

            // Destroy all terminals except the active one
            for (const t of all) {
                if (t !== active)
                    t.destroy();
            }

            // Remove the split tree
            this.remove(this._content);

            // Re-add the active terminal directly
            this._content = active;
            active.hexpand = true;
            active.vexpand = true;

            // Reparent if needed
            const parent = active.get_parent();
            if (parent)
                parent.remove(active);

            this.add(active);
            active.grab_focus();
        } finally {
            this._restructuring = false;
        }

        this._update_is_split();
        this.emit('session-update');
    }

    collapse_terminal(terminal) {
        if (!this.is_split)
            return;

        const parent_split = this._find_parent_split(terminal);
        if (!parent_split)
            return;

        const sibling = parent_split.get_child1() === terminal
            ? parent_split.get_child2()
            : parent_split.get_child1();

        if (!sibling)
            return;

        this._restructuring = true;

        try {
            parent_split.remove(sibling);

            if (parent_split === this._content) {
                // Root split is being collapsed
                this.remove(parent_split);
                this._content = sibling;
                sibling.hexpand = true;
                sibling.vexpand = true;
                this.add(sibling);
            } else {
                // Find grandparent and replace parent_split with sibling
                const grandparent = this._find_parent_split(parent_split);
                if (grandparent)
                    grandparent.replace_child(parent_split, sibling);
            }

            sibling.grab_focus();
        } finally {
            this._restructuring = false;
        }

        this._update_is_split();
        this._update_active_terminal();
        this.emit('session-update');
    }

    _handle_move_to_other_pane(terminal) {
        if (!this.is_split)
            return;

        const all = this.get_all_terminals();
        const idx = all.indexOf(terminal);
        if (idx < 0 || all.length <= 1)
            return;

        const dest_idx = (idx + 1) % all.length;
        // Focus the next terminal
        all[dest_idx].grab_focus();
    }

    close_active_terminal() {
        if (!this.is_split)
            return;

        const active = this._active_terminal;
        if (!active)
            return;

        this._restructuring = true;
        try {
            this.collapse_terminal(active);
            active.close();
        } finally {
            this._restructuring = false;
        }
    }

    adjust_split_position(delta) {
        if (!this.is_split)
            return;

        const active = this._active_terminal;
        if (!active)
            return;

        const parent = this._find_parent_split(active);
        const target = parent || this._content;

        if (target instanceof SplitContainer)
            target.split_position = target.split_position + delta;
    }

    focus_adjacent_terminal(direction) {
        const all = this.get_all_terminals();
        if (all.length <= 1)
            return;

        const active = this._active_terminal;
        const idx = all.indexOf(active);
        if (idx < 0)
            return;

        const next_idx = (all.length + idx + direction) % all.length;
        all[next_idx].grab_focus();
    }

    _find_parent_split(child) {
        if (!(this._content instanceof SplitContainer))
            return null;

        return this._find_parent_split_recursive(this._content, child);
    }

    _find_parent_split_recursive(split, child) {
        if (split.get_child1() === child || split.get_child2() === child)
            return split;

        const c1 = split.get_child1();
        if (c1 instanceof SplitContainer) {
            const found = this._find_parent_split_recursive(c1, child);
            if (found)
                return found;
        }

        const c2 = split.get_child2();
        if (c2 instanceof SplitContainer) {
            const found = this._find_parent_split_recursive(c2, child);
            if (found)
                return found;
        }

        return null;
    }

    _clear_content() {
        if (this._content) {
            this.remove(this._content);
            this._content = null;
        }
    }

    _update_active_terminal() {
        let terminal = null;

        if (this._content instanceof TerminalPage) {
            terminal = this._content;
        } else if (this._content instanceof SplitContainer) {
            terminal = this._content.active_terminal;
        }

        this._set_active_terminal(terminal);
    }

    _set_active_terminal(terminal) {
        if (this._active_terminal === terminal)
            return;

        this._title_binding?.unbind();
        this._title_binding = null;

        this._active_terminal = terminal;

        if (terminal) {
            this._title_binding = terminal.bind_property(
                'title',
                this.tab_label,
                'label',
                GObject.BindingFlags.SYNC_CREATE
            );
            this.tab_label.insert_action_group('page', terminal.get_action_group('page'));
        } else {
            this.tab_label.insert_action_group('page', null);
        }

        this.notify('title');
    }

    _update_is_split() {
        this.notify('is-split');
        const is_split = this.is_split;
        for (const t of this.get_all_terminals())
            t.set_is_split(is_split);
    }

    _close_tab() {
        this._restructuring = true;

        // Destroy terminals explicitly before destroying the container,
        // so child-exited signals fire while still in valid JS context.
        for (const t of this.get_all_terminals())
            t.destroy();

        this.destroy();
    }

    vfunc_grab_focus() {
        const active = this._active_terminal;
        if (active?.get_parent()) {
            active.grab_focus();
            return;
        }

        for (const t of this.get_all_terminals()) {
            if (t.get_parent()) {
                t.grab_focus();
                return;
            }
        }
    }

    get_cwd() {
        return this._active_terminal?.get_cwd() ?? null;
    }

    serialize_state() {
        if (!this._content || !this._content.get_parent())
            return null;

        if (this._content instanceof TerminalPage)
            return _serialize_terminal(this._content);

        if (this._content instanceof SplitContainer)
            return this._content.serialize_state();

        return null;
    }

    static deserialize_state(variant, terminal_settings, menus) {
        const dict = GLib.VariantDict.new(variant);
        const type = dict.lookup('type', 's');

        const container = new TabContentContainer({
            terminal_settings,
            menus,
        });

        if (type === 'split') {
            const create_terminal = v => {
                return _deserialize_terminal(v, terminal_settings, menus);
            };
            const split = SplitContainer.deserialize_state(variant, create_terminal);
            if (split) {
                split.hexpand = true;
                split.vexpand = true;
                container._content = split;
                container.add(split);

                split.connect('session-update', () => container.emit('session-update'));

                // Connect signals to all deserialized terminals
                for (const t of split.get_all_terminals())
                    container._connect_terminal(t);

                container._update_active_terminal();
                container._update_is_split();
            }
        } else {
            // Single terminal (type === 'terminal' or legacy format)
            const page = _deserialize_terminal(variant, terminal_settings, menus);
            container.set_terminal(page);
        }

        return container;
    }
});

function _serialize_terminal(page) {
    const data = page.serialize_state();
    const dict = GLib.VariantDict.new(data);
    dict.insert_value('type', GLib.Variant.new_string('terminal'));
    return dict.end();
}

function _deserialize_terminal(variant, terminal_settings, menus) {
    return TerminalPage.deserialize_state(variant, {
        terminal_settings,
        terminal_menu: menus.get_object('terminal-popup'),
        tab_menu: menus.get_object('tab-popup'),
        visible: true,
    });
}
