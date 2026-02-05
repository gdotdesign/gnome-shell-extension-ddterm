// SPDX-FileCopyrightText: 2025 Aleksandr Mezin <mezin.alexander@gmail.com>
//
// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

function _is_split_container(widget) {
    return widget instanceof SplitContainer;
}

function _is_terminal(widget) {
    return !_is_split_container(widget) && widget instanceof Gtk.Box;
}

export const SplitContainer = GObject.registerClass({
    Properties: {
        'split-position': GObject.ParamSpec.double(
            'split-position',
            null,
            null,
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.EXPLICIT_NOTIFY,
            0.0,
            1.0,
            0.5
        ),
    },
    Signals: {
        'session-update': {},
    },
}, class DDTermSplitContainer extends Gtk.Paned {
    _init(params) {
        super._init(params);

        this._split_position = 0.5;
        this._active_child = null;
        this._updating_position = false;
        this._position_initialized = false;
        this._last_alloc_size = -1;

        this.connect('set-focus-child', this._on_focus_child_change.bind(this));
        this.connect('notify::position', this._on_paned_position_changed.bind(this));
        this.connect('size-allocate', this._on_size_allocate.bind(this));
    }

    get first_child() {
        return this.get_child1();
    }

    get second_child() {
        return this.get_child2();
    }

    get split_position() {
        return this._split_position;
    }

    set split_position(value) {
        value = Math.max(0.0, Math.min(1.0, value));
        if (this._split_position === value)
            return;

        this._split_position = value;
        this._apply_split_position();
        this.notify('split-position');
    }

    get active_terminal() {
        if (this._active_child) {
            if (_is_terminal(this._active_child))
                return this._active_child;

            if (_is_split_container(this._active_child))
                return this._active_child.active_terminal;
        }

        const focus = this.get_focus_child();
        if (focus) {
            if (_is_terminal(focus))
                return focus;

            if (_is_split_container(focus))
                return focus.active_terminal;
        }

        return this._get_first_terminal();
    }

    _on_focus_child_change(_paned, child) {
        this._active_child = child;
    }

    _get_first_terminal() {
        const child1 = this.get_child1();
        if (child1) {
            if (_is_terminal(child1))
                return child1;
            if (_is_split_container(child1))
                return child1._get_first_terminal();
        }

        const child2 = this.get_child2();
        if (child2) {
            if (_is_terminal(child2))
                return child2;
            if (_is_split_container(child2))
                return child2._get_first_terminal();
        }

        return null;
    }

    _on_paned_position_changed() {
        if (this._updating_position || !this._position_initialized)
            return;

        const range = this.max_position - this.min_position;
        if (range <= 0)
            return;

        const paned_pos = this.get_position();
        const normalized = (paned_pos - this.min_position) / range;

        if (Math.abs(normalized - this._split_position) > 0.001) {
            this._split_position = normalized;
            this.notify('split-position');
        }
    }

    _apply_split_position() {
        const range = this.max_position - this.min_position;
        if (range <= 0)
            return;

        this._updating_position = true;
        try {
            const pixel_pos = Math.round(this.min_position + this._split_position * range);
            this.set_position(pixel_pos);
        } finally {
            this._updating_position = false;
            this._position_initialized = true;
        }
    }

    _on_size_allocate(_widget, allocation) {
        const size = this.orientation === Gtk.Orientation.HORIZONTAL
            ? allocation.width : allocation.height;

        if (size !== this._last_alloc_size) {
            this._last_alloc_size = size;
            this._apply_split_position();
        }
    }

    get_all_terminals() {
        const result = [];
        this._collect_terminals(result);
        return result;
    }

    _collect_terminals(result) {
        for (const child of [this.get_child1(), this.get_child2()]) {
            if (!child)
                continue;

            if (_is_terminal(child))
                result.push(child);
            else if (_is_split_container(child))
                child._collect_terminals(result);
        }
    }

    find_direct_child_containing(terminal) {
        const child1 = this.get_child1();
        const child2 = this.get_child2();

        if (child1 === terminal || child2 === terminal)
            return terminal === child1 ? child1 : child2;

        if (_is_split_container(child1) && child1.contains_terminal(terminal))
            return child1;

        if (_is_split_container(child2) && child2.contains_terminal(terminal))
            return child2;

        return null;
    }

    contains_terminal(terminal) {
        const child1 = this.get_child1();
        const child2 = this.get_child2();

        if (child1 === terminal || child2 === terminal)
            return true;

        if (_is_split_container(child1) && child1.contains_terminal(terminal))
            return true;

        if (_is_split_container(child2) && child2.contains_terminal(terminal))
            return true;

        return false;
    }

    replace_child(old_child, new_child) {
        const child1 = this.get_child1();

        if (old_child === child1) {
            this.remove(old_child);
            this.pack1(new_child, true, true);
        } else {
            this.remove(old_child);
            this.pack2(new_child, true, true);
        }
    }

    serialize_state() {
        const properties = GLib.VariantDict.new(null);

        properties.insert_value('type', GLib.Variant.new_string('split'));
        properties.insert_value('orientation', GLib.Variant.new_int32(this.orientation));
        properties.insert_value('split-position', GLib.Variant.new_double(this._split_position));

        const child1 = this.get_child1();
        const child2 = this.get_child2();

        if (child1) {
            const data = _serialize_node(child1);
            if (data)
                properties.insert_value('first', data);
        }

        if (child2) {
            const data = _serialize_node(child2);
            if (data)
                properties.insert_value('second', data);
        }

        return properties.end();
    }

    static deserialize_state(variant, create_terminal) {
        const dict = GLib.VariantDict.new(variant);
        const type = dict.lookup('type', 's');

        if (type !== 'split')
            return null;

        const orientation = dict.lookup('orientation', 'i') ?? Gtk.Orientation.HORIZONTAL;
        const position = dict.lookup('split-position', 'd');
        const variant_dict_type = new GLib.VariantType('a{sv}');
        const first_data = dict.lookup_value('first', variant_dict_type);
        const second_data = dict.lookup_value('second', variant_dict_type);

        const split = new SplitContainer({
            orientation,
            visible: true,
        });

        if (first_data) {
            const child = _deserialize_node(first_data, create_terminal);
            if (child)
                split.pack1(child, true, true);
        }

        if (second_data) {
            const child = _deserialize_node(second_data, create_terminal);
            if (child)
                split.pack2(child, true, true);
        }

        if (position !== null)
            split._split_position = position;

        // Apply position after widget gets its allocation
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            split._apply_split_position();
            return GLib.SOURCE_REMOVE;
        });

        return split;
    }
});

function _serialize_node(child) {
    if (_is_terminal(child)) {
        const data = child.serialize_state();
        const dict = GLib.VariantDict.new(data);
        dict.insert_value('type', GLib.Variant.new_string('terminal'));
        return dict.end();
    } else if (_is_split_container(child)) {
        return child.serialize_state();
    }
    return null;
}

function _deserialize_node(variant, create_terminal) {
    const dict = GLib.VariantDict.new(variant);
    const type = dict.lookup('type', 's');

    if (type === 'terminal') {
        const terminal = create_terminal(variant);
        return terminal;
    } else if (type === 'split') {
        return SplitContainer.deserialize_state(variant, create_terminal);
    }

    return null;
}
