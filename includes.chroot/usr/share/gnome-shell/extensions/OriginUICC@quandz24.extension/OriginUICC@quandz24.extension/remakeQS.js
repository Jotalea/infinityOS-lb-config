import GLib from "gi://GLib";
import Gio from "gi://Gio";
import St from "gi://St";
import Clutter from "gi://Clutter";
import GObject from "gi://GObject";
import Meta from "gi://Meta";
import Graphene from "gi://Graphene";
import {QuickToggle} from "resource:///org/gnome/shell/ui/quickSettings.js";

import * as Main from "resource:///org/gnome/shell/ui/main.js";

export const delayRatio = 25; // delay += delayRatio for each visible row
export const animationDuration = 550;
export const animationCubicBezier = [0.23, 1.32, 0.2, 1];
export const startScale = 0.6;
export const startTranslateY = 70;
export const FRAME_INTERVAL = 1000 / 60;

export function _cubic(a, b, t) {
  const inv = 1 - t;
  return 3 * inv * inv * t * a + 3 * inv * t * t * b + t * t * t;
}

export function _cubicDerivative(a, b, t) {
  const inv = 1 - t;
  return 3 * inv * inv * a + 6 * inv * t * (b - a) + 3 * t * t * (1 - b);
}

export function _cubicBezierProgress(x1, y1, x2, y2, progress) {
  progress = Math.clamp(progress, 0, 1);

  let t = progress;
  for (let i = 0; i < 8; i++) {
    const x = _cubic(x1, x2, t) - progress;
    const dx = _cubicDerivative(x1, x2, t);

    if (Math.abs(x) < 0.000001 || Math.abs(dx) < 0.000001) break;
    t = Math.clamp(t - x / dx, 0, 1);
  }

  let lower = 0;
  let upper = 1;
  for (let i = 0; i < 8; i++) {
    const x = _cubic(x1, x2, t);

    if (Math.abs(x - progress) < 0.000001) break;
    if (x < progress) lower = t;
    else upper = t;

    t = (lower + upper) / 2;
  }

  return _cubic(y1, y2, t);
}

export function restoreActor(actor) {
  if (!actor || actor.is_destroyed?.()) return;

  actor.remove_all_transitions?.();
  actor.opacity = 255;
  actor.scale_x = 1;
  actor.scale_y = 1;
  actor.translation_y = 0;
}

export function stopActorAnimation(
  actor,
  animationIds,
  animationTokens,
  restore = false,
) {
  const frameId = animationIds?.get(actor);

  if (frameId) GLib.source_remove(frameId);

  animationIds?.delete(actor);
  animationTokens?.delete?.(actor);

  if (restore) restoreActor(actor);
}

/**
 * Generic animation engine.
 *
 * @param {Clutter.Actor} actor   - The actor to animate.
 * @param {object}        start   - Start state: { translateX, translateY, scale, opacity, rotateX, rotateY, rotateZ }
 * @param {object}        end     - End state:   { translateX, translateY, scale, opacity, rotateX, rotateY, rotateZ }
 * @param {object}        options - Options:
 *    duration      {number}   ms, default animationDuration
 *    delay         {number}   ms, default 0
 *    animationIds  {Map}
 *    animationTokens {WeakMap}
 *    tokenSymbol   {Symbol}
 *    errorTag      {string}
 *    fill          {string}   "both" | "forwards" (informational)
 *    onStart       {Function} called once before animation starts
 *    onUpdate      {Function} called each frame with (actor, easedProgress)
 *    onFinish      {Function} called when animation completes
 */
export function animateActorOpen(actor, start = {}, end = {}, options = {}) {
  if (!actor || actor.is_destroyed?.()) return;

  const {
    duration = animationDuration,
    delay = 0,
    animationIds,
    animationTokens,
    tokenSymbol = Symbol("open-animation"),
    errorTag = "OriginUICC open animation failed",
    onStart,
    onUpdate,
    onFinish,
  } = options;

  stopActorAnimation(actor, animationIds, animationTokens, false);

  const token = tokenSymbol;
  animationTokens?.set(actor, token);

  actor.remove_all_transitions?.();
  actor.set_pivot_point?.(0.5, 0.5);

  // ── Per-property config parser ─────────────────────────────────────────
  // Each property in start/end can be a plain number OR an object:
  //   { value: <number>, delay: <ms>, cubicBezier: [x1,y1,x2,y2] }
  //   start.X.delay  → positive ms: property starts that many ms after global delay
  //   end.X.delay    → negative ms or "-5%": property finishes that amount earlier
  //   cubicBezier    → only honoured on start; overrides global bezier for this prop
  const _pp = (raw) => {
    if (raw == null) return { value: null, delay: 0, cubicBezier: null };
    if (typeof raw === "object" && !Array.isArray(raw))
      return {
        value: raw.value ?? null,
        delay: raw.delay ?? 0,
        cubicBezier: Array.isArray(raw.cubicBezier) ? raw.cubicBezier : null,
      };
    return { value: raw, delay: 0, cubicBezier: null };
  };

  const KEYS = [
    "translateX",
    "translateY",
    "scaleX",
    "scaleY",
    "opacity",
    "rotateX",
    "rotateY",
    "rotateZ",
  ];
  const sp = {};
  const ep = {};
  for (const k of KEYS) {
    sp[k] = _pp(start[k]);
    ep[k] = _pp(end[k]);
  }

  // ── Snapshot original actor state BEFORE snapping ─────────────────────
  const orig = {
    translateX: actor.translation_x ?? 0,
    translateY: actor.translation_y ?? 0,
    scaleX: actor.scale_x ?? 1,
    scaleY: actor.scale_y ?? 1,
    opacity: actor.opacity ?? 255,
    rotateX: actor.rotation_angle_x ?? 0,
    rotateY: actor.rotation_angle_y ?? 0,
    rotateZ: actor.rotation_angle_z ?? 0,
  };

  // ── Resolve start values (fallback: current actor state) ───────────────
  const s = {};
  for (const k of KEYS) s[k] = sp[k].value ?? orig[k];

  // ── Resolve end values ─────────────────────────────────────────────────
  // • end.X explicitly set         → use it
  // • end.X missing but start.X set → animate back to pre-animation orig value
  // • both missing                  → no animation for this property
  const e = {};
  for (const k of KEYS) {
    if (ep[k].value != null) e[k] = ep[k].value;
    else if (sp[k].value != null) e[k] = orig[k];
    else e[k] = s[k];
  }

  // ── Snap actor to start state ──────────────────────────────────────────
  actor.translation_x = s.translateX;
  actor.translation_y = s.translateY;
  actor.scale_x = s.scaleX;
  actor.scale_y = s.scaleY;
  actor.opacity = Math.clamp(Math.round(s.opacity), 0, 255);
  actor.rotation_angle_x = s.rotateX;
  actor.rotation_angle_y = s.rotateY;
  actor.rotation_angle_z = s.rotateZ;

  if (onStart) onStart(actor);

  const startTime = GLib.get_monotonic_time();
  const [x1, y1, x2, y2] = options.cubicBezier || animationCubicBezier;
  const dur = Math.max(1, duration);

  // ── Per-property eased progress ────────────────────────────────────────
  const _propEased = (k, elapsed) => {
    const propStartDelay = Math.max(0, sp[k].delay || 0);
    const active = elapsed - delay - propStartDelay;
    if (active <= 0) return 0;

    const rawEnd = ep[k].delay || 0;
    let endMs = 0;
    if (typeof rawEnd === "string" && rawEnd.endsWith("%")) {
      endMs = (-dur * Math.abs(parseFloat(rawEnd))) / 100;
    } else {
      endMs = Math.min(0, rawEnd);
    }

    const effectiveDur = Math.max(1, dur + endMs);
    const progress = Math.clamp(active / effectiveDur, 0, 1);

    const bez = sp[k].cubicBezier;
    if (bez && bez.length === 4)
      return _cubicBezierProgress(bez[0], bez[1], bez[2], bez[3], progress);
    return _cubicBezierProgress(x1, y1, x2, y2, progress);
  };

  // Total duration accounts for the slowest per-property start delay
  const maxPropDelay = Math.max(
    0,
    ...KEYS.map((k) => Math.max(0, sp[k].delay || 0)),
  );
  const totalDur = dur + maxPropDelay;

  const frameId = GLib.timeout_add(
    GLib.PRIORITY_DEFAULT,
    FRAME_INTERVAL,
    () => {
      try {
        if (
          actor.is_destroyed?.() ||
          !actor.get_stage?.() ||
          animationTokens?.get(actor) !== token
        ) {
          animationIds?.delete(actor);
          return GLib.SOURCE_REMOVE;
        }

        const elapsed = (GLib.get_monotonic_time() - startTime) / 1000;
        const activeElapsed = elapsed - delay;
        if (activeElapsed < 0) return GLib.SOURCE_CONTINUE;

        const globalProgress = Math.clamp(activeElapsed / totalDur, 0, 1);

        actor.translation_x =
          s.translateX +
          (e.translateX - s.translateX) * _propEased("translateX", elapsed);
        actor.translation_y =
          s.translateY +
          (e.translateY - s.translateY) * _propEased("translateY", elapsed);
        const scaleXV =
          s.scaleX + (e.scaleX - s.scaleX) * _propEased("scaleX", elapsed);
        const scaleYV =
          s.scaleY + (e.scaleY - s.scaleY) * _propEased("scaleY", elapsed);
        actor.scale_x = scaleXV;
        actor.scale_y = scaleYV;
        actor.opacity = Math.clamp(
          Math.round(
            s.opacity +
              (e.opacity - s.opacity) * _propEased("opacity", elapsed),
          ),
          0,
          255,
        );
        actor.rotation_angle_x =
          s.rotateX + (e.rotateX - s.rotateX) * _propEased("rotateX", elapsed);
        actor.rotation_angle_y =
          s.rotateY + (e.rotateY - s.rotateY) * _propEased("rotateY", elapsed);
        actor.rotation_angle_z =
          s.rotateZ + (e.rotateZ - s.rotateZ) * _propEased("rotateZ", elapsed);

        if (onUpdate) onUpdate(actor, globalProgress);

        if (globalProgress < 1) return GLib.SOURCE_CONTINUE;

        // Snap to exact end state
        actor.translation_x = e.translateX;
        actor.translation_y = e.translateY;
        actor.scale_x = e.scaleX;
        actor.scale_y = e.scaleY;
        actor.opacity = Math.clamp(Math.round(e.opacity), 0, 255);
        actor.rotation_angle_x = e.rotateX;
        actor.rotation_angle_y = e.rotateY;
        actor.rotation_angle_z = e.rotateZ;

        if (onFinish) onFinish(actor);
        animationIds?.delete(actor);
        return GLib.SOURCE_REMOVE;
      } catch (err) {
        logError(err, errorTag);
        animationIds?.delete(actor);
        restoreActor(actor);
        return GLib.SOURCE_REMOVE;
      }
    },
  );

  animationIds?.set(actor, frameId);
}

// Keep Shell's child metadata and submenu overlay, while allocating real cells
// for compact, pill and large controls. Shell's stock layout only spans columns.
const OriginUICCControlLayout = GObject.registerClass({
  GTypeName: 'OriginUICCControlLayout',
}, class OriginUICCControlLayout extends Clutter.LayoutManager {
  _init(state, originalLayout) {
    super._init();
    this.state = state;
    this.nColumns = 4;
    this._overlay = originalLayout._overlay;
    this._metaType = originalLayout.vfunc_get_child_meta_type();
  }

  vfunc_get_child_meta_type() { return this._metaType; }

  _metrics() {
    const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
    return {cell: this.state.cellSize ?? 64 * scale, gap: 10 * scale};
  }

  _preferredWidth(container) {
    const {cell, gap} = this._metrics();
    let width = 4 * cell + 3 * gap;
    for (const actor of container.get_children()) {
      if (!actor.visible || actor === this._overlay || this.state.actors.has(actor) || this.state.sliders.has(actor)) continue;
      width = Math.max(width, actor.get_preferred_width(-1)[0]);
    }
    return width;
  }

  _plan(container, width) {
    const metrics = this._metrics();
    const gap = metrics.gap;
    const cell = Math.max(1, Math.min(metrics.cell, (width - 3 * gap) / 4));
    const columnGap = Math.max(gap, (width - 4 * cell) / 3);
    const slots = new Map();
    let y = 0;
    let column = 0;
    let rowHeight = 0;
    // The system actions stay in a separate, fixed section above the controls.
    for (const actor of container.get_children()) {
      if (!actor.visible || actor === this._overlay || this.state.actors.has(actor) || this.state.sliders.has(actor)) continue;
      const span = Math.min(4, this.get_child_meta(container, actor).columnSpan ?? 4);
      if (column + span > 4) { y += rowHeight + gap; column = 0; rowHeight = 0; }
      const actorWidth = span * cell + (span - 1) * columnGap;
      const height = Math.max(1, actor.get_preferred_height(actorWidth)[1]);
      slots.set(actor, {x: column * (cell + columnGap), y, width: actorWidth, height});
      rowHeight = Math.max(rowHeight, height);
      column += span;
      if (column === 4) { y += rowHeight + gap; column = 0; rowHeight = 0; }
    }
    if (column > 0) y += rowHeight + gap;
    const baseY = y;
    const cells = [];
    let usedRows = 0;
    for (const actor of container.get_children()) {
      const rec = this.state.actors.get(actor) ?? this.state.sliders.get(actor);
      if (!rec || rec.removed || !actor.visible) continue;
      const [cols, rows] = this.state.sliders.has(actor) ? [4, 1]
        : rec.size === '1x1' ? [1, 1] : rec.size === '2x2' ? [2, 2] : [2, 1];
      let placed = false;
      for (let row = 0; !placed; row++) {
        for (let col = 0; col <= 4 - cols && !placed; col++) {
          let free = true;
          for (let dy = 0; dy < rows; dy++)
            for (let dx = 0; dx < cols; dx++)
              if (cells[row + dy]?.[col + dx]) free = false;
          if (!free) continue;
          for (let dy = 0; dy < rows; dy++) {
            cells[row + dy] ??= [];
            for (let dx = 0; dx < cols; dx++) cells[row + dy][col + dx] = true;
          }
          slots.set(actor, {x: col * (cell + columnGap), y: baseY + row * (cell + gap),
            width: cols * cell + (cols - 1) * columnGap, height: rows * cell + (rows - 1) * gap});
          usedRows = Math.max(usedRows, row + rows);
          placed = true;
        }
      }
    }
    let height = usedRows ? baseY + usedRows * (cell + gap) - gap : Math.max(0, baseY - gap);
    const overlayHeight = this._overlay?.get_preferred_height(-1)[1] ?? 0;
    const openActor = [...slots.keys()].find(actor => actor.menu?.actor.visible);
    let menuY = null;
    if (openActor && overlayHeight > 0) {
      const source = slots.get(openActor);
      menuY = source.y + source.height;
      // An expanded menu begins after every control crossing its row. Keeping
      // a single cut prevents a large neighbor from colliding with later rows.
      let previous;
      do {
        previous = menuY;
        for (const slot of slots.values())
          if (slot.y < menuY && slot.y + slot.height > menuY) menuY = slot.y + slot.height;
      } while (menuY !== previous);
      for (const slot of slots.values())
        if (slot.y >= menuY) slot.y += overlayHeight;
      height = Math.max(height, menuY) + overlayHeight;
    }
    return {slots, height, openActor, menuY};
  }

  vfunc_get_preferred_width(container, _forHeight) {
    const width = this._preferredWidth(container);
    return [width, width];
  }

  vfunc_get_preferred_height(container, forWidth) {
    const width = forWidth > 0 ? forWidth : this._preferredWidth(container);
    const {height} = this._plan(container, width);
    return [height, height];
  }

  vfunc_allocate(container, box) {
    const width = box.get_width();
    const {slots, openActor, menuY} = this._plan(container, width);
    const rtl = container.text_direction === Clutter.TextDirection.RTL;
    this._overlay?.allocate_available_size(0, 0, width, box.get_height());
    for (const [actor, slot] of slots) {
      const childBox = new Clutter.ActorBox();
      childBox.set_origin(box.x1 + (rtl ? width - slot.x - slot.width : slot.x), box.y1 + slot.y);
      childBox.set_size(slot.width, slot.height);
      actor.allocate(childBox);
    }
    if (openActor && menuY !== null) {
      const binding = openActor.menu.actor.get_constraints().find(constraint =>
        constraint instanceof Clutter.BindConstraint && constraint.coordinate === Clutter.BindCoordinate.Y && constraint.source === openActor);
      const offset = menuY - slots.get(openActor).y;
      if (binding && Math.abs(binding.offset - offset) > 0.5) binding.offset = offset;
    }
  }
});

export class QuickSettingsRemake {
  constructor(extension = null) {
    this._extension = extension;
  }

  enable() {
    this._quickSettingsMenus = new Map();
    this._setupId = 0;
    this._colorSchemeSignalId = 0;
    this._animationIds = new Map();
    this._animationTokens = new WeakMap();
    this._quickToggleMenuSignals = new Map();
    this._toggleHoverSignals = new Map();
    this._colorSettings = St.Settings.get();
    this._editorMenus = new Map();
    this._layoutFile = GLib.build_filenamev([GLib.get_user_config_dir(), "originuicc", "quick-settings.json"]);
    // A dedicated onboarding key makes the new What's New panel appear once
    // even for users who already dismissed the older modal assistant.
    this._assistantVersion = `${this._extension?.metadata?.uuid ?? "OriginUICC"}:whats-new-v2`;
    this._savedLayout = this._readLayout();
    this._savedRemoved = this._readRemoved();
    this._defaultLayoutPending = this._needsDefaultLayout();

    this._colorSchemeSignalId = this._colorSettings.connect(
      "notify::color-scheme",
      () => this._syncAllColorSchemes(),
    );

    this._setupQuickSettingsHook();

    this._setupId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
      this._setupQuickSettingsHook();
      return GLib.SOURCE_CONTINUE;
    });
  }

  disable() {
    if (this._setupId) {
      GLib.source_remove(this._setupId);
      this._setupId = 0;
    }

    for (const [menu, signalId] of this._quickSettingsMenus) {
      try {
        menu.disconnect(signalId);
      } catch (_) {}
    }

    for (const [quickToggleMenu, signalId] of this._quickToggleMenuSignals) {
      try {
        quickToggleMenu.disconnect(signalId);
      } catch (_) {}
    }
    this._quickToggleMenuSignals.clear();

    for (const [actor, hover] of this._toggleHoverSignals) {
      if (hover.fadeSource) GLib.source_remove(hover.fadeSource);
      for (const signalId of hover.signals) {
        try {
          actor.disconnect(signalId);
        } catch (_) {}
      }
      if (!actor.is_destroyed?.()) actor.set_style(null);
    }
    this._toggleHoverSignals.clear();

    if (this._colorSchemeSignalId && this._colorSettings) {
      this._colorSettings.disconnect(this._colorSchemeSignalId);
      this._colorSchemeSignalId = 0;
    }

    this._clearAllColorSchemes();
    for (const state of this._editorMenus.values()) this._cleanupEditor(state);
    this._editorMenus.clear();
    this._quickSettingsMenus.clear();
    this._stopAllAnimations(true);
    this._colorSettings = null;
  }

  _setupQuickSettingsHook() {
    const menus = this._getQuickSettingsMenus();

    for (const [menu, signalId] of this._quickSettingsMenus) {
      if (menus.has(menu)) continue;

      try {
        menu.disconnect(signalId);
      } catch (_) {}
      menu?._boxPointer?.remove_style_class_name(
        "originuicc-transparent-boxpointer",
      );
      this._disconnectQuickToggleMenuHooksForMenu(menu);
      const editorState = this._editorMenus.get(menu);
      if (editorState) { this._cleanupEditor(editorState); this._editorMenus.delete(menu); }
      this._quickSettingsMenus.delete(menu);
    }

    for (const menu of menus) {
      if (this._quickSettingsMenus.has(menu)) continue;

      const signalId = menu.connect("open-state-changed", (_menu, isOpen) => {
        if (isOpen) {
          const editorState = this._editorMenus.get(_menu);
          if (!editorState?.galleryPanel) this._animateQuickSettingsOpen(_menu);
          if (editorState) this._maybeShowAssistant(editorState);
        } else {
          const editorState = this._editorMenus.get(_menu);
          if (editorState?.galleryPanel && editorState.editing) {
            // The gallery lives beside the popup. Reopen the popup after a
            // gallery click so PopupMenuManager's outside-click close cannot
            // dismiss the editor underneath the gallery.
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
              if (editorState.galleryPanel && editorState.editing && !_menu.isOpen)
                _menu.open();
              return GLib.SOURCE_REMOVE;
            });
          } else if (editorState?.editing) {
            if (editorState.exitAction === false) this._restoreEditorSnapshot(editorState);
            this._savedLayout = this._serializeLayout(editorState);
            this._savedRemoved = [...editorState.removed];
            this._writeLayout(this._savedLayout, this._savedRemoved);
            editorState.savedApplied = true;
            this._closeEditor(editorState);
          }
          if (!editorState?.galleryPanel) this._stopAllAnimations(true);
        }
      });

      this._quickSettingsMenus.set(menu, signalId);
      this._syncColorScheme(menu);
    }

    for (const menu of menus) {
      this._setupQuickToggleMenuHooks(menu);
      this._setupToggleHoverEffects(menu);
      this._setupControlEditor(menu);
    }
  }

  _readLayout() {
    try {
      const [, bytes] = GLib.file_get_contents(this._layoutFile);
      return JSON.parse(new TextDecoder().decode(bytes)).layout ?? [];
    } catch (_) { return []; }
  }

  _needsDefaultLayout() {
    try {
      const [, bytes] = GLib.file_get_contents(this._layoutFile);
      return (JSON.parse(new TextDecoder().decode(bytes)).version ?? 0) < 4;
    } catch (_) { return true; }
  }

  _readRemoved() {
    try {
      const [, bytes] = GLib.file_get_contents(this._layoutFile);
      return JSON.parse(new TextDecoder().decode(bytes)).removed ?? [];
    } catch (_) { return []; }
  }

  _writeLayout(layout, removed = this._savedRemoved ?? [], assistantVersion = null) {
    try {
      GLib.mkdir_with_parents(GLib.path_get_dirname(this._layoutFile), 0o755);
      let seenVersion = assistantVersion;
      if (!seenVersion) {
        try {
          const [, bytes] = GLib.file_get_contents(this._layoutFile);
          seenVersion = JSON.parse(new TextDecoder().decode(bytes)).assistantVersion ?? null;
        } catch (_) {}
      }
      const data = {version: 4, layout, removed};
      if (seenVersion) data.assistantVersion = seenVersion;
      GLib.file_set_contents(this._layoutFile, JSON.stringify(data));
    } catch (e) { logError(e, "Could not save Quick Settings layout"); }
  }

  _controlDescription(actor) {
    const labels = [];
    const icons = [];
    const visit = widget => {
      if (widget instanceof St.Label && widget.text) labels.push(widget.text);
      if (widget instanceof St.Icon && widget.icon_name) icons.push(widget.icon_name);
      for (const child of widget?.get_children?.() ?? []) visit(child);
    };
    visit(actor);
    const iconNames = [actor?._icon?.icon_name, actor?._box?.get_first_child?.()?.icon_name, actor?.icon_name, ...icons].filter(Boolean).join(" ");
    return `${iconNames} ${actor?.accessible_name ?? ""} ${actor?._title?.text ?? ""} ${labels.join(" ")}`.toLowerCase();
  }

  _isMovableToggle(actor) {
    const classes = actor?.get_style_class_name?.() ?? "";
    return /(^|\s)(quick-toggle|quick-menu-toggle|quick-toggle-has-menu)(\s|$)/.test(classes)
      && !/(^|\s)(power-item|quick-settings-system-item)(\s|$)/.test(classes);
  }

  _controlId(actor) {
    const icon = actor?._box?.get_first_child?.();
    const title = actor?._box?.get_children?.().find(child => child instanceof St.Label)?.text ?? actor?.accessible_name ?? "";
    return `${icon?.icon_name ?? actor?.icon_name ?? "control"}:${title}`;
  }

  _setupControlEditor(menu) {
    const grid = menu?._grid;
    if (!grid || !menu.box) return;
    let state = this._editorMenus.get(menu);
    if (!state) {
      menu.box.add_style_class_name("originuicc-control-centre");
      const layoutManager = grid.layout_manager;
      const originalColumns = layoutManager.nColumns ?? layoutManager.n_columns ?? 2;
      try { layoutManager.nColumns = 4; } catch (_) {}
      const editButton = new St.Button({label: "Edit", style_class: "originuicc-edit-button", x_expand: false, x_align: Clutter.ActorAlign.CENTER, can_focus: true});
      const toolbar = new St.BoxLayout({vertical: true, style_class: "originuicc-editor-toolbar", visible: false});
      const actions = new St.BoxLayout({style_class: "originuicc-editor-actions", x_align: Clutter.ActorAlign.CENTER});
      const addButton = this._makeToolbarButton("Add Control");
      const resetButton = new St.Button({label: "Reset", style_class: "originuicc-reset-button", can_focus: true});
      actions.add_child(addButton);
      actions.add_child(resetButton);
      const doneButton = new St.Button({label: "Done", style_class: "originuicc-done-button", can_focus: true, x_expand: true});
      toolbar.add_child(actions);
      toolbar.add_child(doneButton);
      menu.box.add_child(editButton);
      menu.box.add_child(toolbar);
      state = {menu, grid, button: editButton, toolbar, addButton, resetButton, doneButton, actions, originalLayout: layoutManager, originalColumns, editing: false, actors: new Map(), sliders: new Map(), removed: new Set(this._savedRemoved), fixedSpans: new Map(), fixedRowSpans: new Map(), originalPositions: new Map(), initialOrder: [], saved: null, savedRemoved: [], assistantShown: false, savedApplied: false, signature: "", stablePasses: 0};
      state.clickId = editButton.connect("clicked", () => this._enterEditMode(state));
      state.addId = addButton.connect("clicked", () => this._openControlGallery(state));
      state.resetId = resetButton.connect("clicked", () => this._resetLayout(state));
      state.doneId = doneButton.connect("clicked", () => this._finishEdit(state));
      // Keep the editor handles inside the popup's input scope without
      // participating in its measured layout. A 1px unclipped host avoids
      // changing the menu's requisition while allowing positioned handles.
      state.gripLayer = new St.Widget({layout_manager: new Clutter.FixedLayout(), reactive: true});
      state.gripLayer.set_position(0, 0);
      state.gripLayer.set_size(1, 1);
      state.gripLayer.set_clip_to_allocation(false);
      menu.actor.add_child(state.gripLayer);
      this._editorMenus.set(menu, state);
    }
    if (state.restoring) return;
    for (const [index, child] of grid.get_children().entries())
      if (!state.originalPositions.has(child)) state.originalPositions.set(child, index);

    state.fixedActors = grid.get_children().filter(actor => {
      const classes = actor?.get_style_class_name?.() ?? "";
      return /(^|\s)(quick-toggle|quick-menu-toggle|quick-toggle-has-menu|quick-settings-system-item)(\s|$)/.test(classes) && !this._isMovableToggle(actor);
    });
    state.fixedActors.forEach((actor, index) => {
      if (!state.fixedSpans.has(actor)) {
        let originalSpan = 1;
        try { originalSpan = grid.layout_manager.get_child_meta(grid, actor).columnSpan; } catch (_) {}
        state.fixedSpans.set(actor, originalSpan);
        let originalRowSpan = 1;
        try { originalRowSpan = grid.layout_manager.get_child_meta(grid, actor).rowSpan ?? 1; } catch (_) {}
        state.fixedRowSpans.set(actor, originalRowSpan);
        try { grid.layout_manager.child_set_property(grid, actor, "column-span", /(^|\s)quick-settings-system-item(\s|$)/.test(actor.get_style_class_name?.() ?? "") ? 4 : 2); } catch (_) {}
      }
    });

    for (const actor of grid.get_children().filter(a => this._isMovableToggle(a))) {
      if (state.actors.has(actor)) continue;
      let originalSpan = 1;
      let originalRowSpan = 1;
      try {
        const childMeta = grid.layout_manager.get_child_meta(grid, actor);
        originalSpan = childMeta.columnSpan ?? 1;
        originalRowSpan = childMeta.rowSpan ?? 1;
      } catch (_) {}
      const rec = {id: this._controlId(actor), size: "2x1", originalSpan, originalRowSpan, handle: null, removeButton: null, removed: false};
      const saved = this._savedLayout.find(entry => entry.id === rec.id);
      if (saved) rec.size = this._normalizeTileSize(saved.size);
      state.actors.set(actor, rec);
      state.initialOrder.push(actor);
      this._createControlEditIcons(state, actor, rec);
      this._setTileSize(state, actor, rec.size);
      if (state.removed.has(rec.id)) this._setControlRemoved(state, actor, rec, true);
    }
    for (const actor of grid.get_children().filter(a => /(^|\s)quick-slider(\s|$)/.test(a.get_style_class_name?.() ?? ""))) {
      if (state.sliders.has(actor)) continue;
      let originalSpan = 2;
      let originalRowSpan = 1;
      try {
        const childMeta = grid.layout_manager.get_child_meta(grid, actor);
        originalSpan = childMeta.columnSpan ?? 2;
        originalRowSpan = childMeta.rowSpan ?? 1;
      } catch (_) {}
      const rec = {id: this._controlId(actor), size: "1x4", originalSpan, originalRowSpan, handle: null, removeButton: null, removed: false};
      state.sliders.set(actor, rec);
      state.initialOrder.push(actor);
      this._createControlEditIcons(state, actor, rec, false);
      this._setSliderSize(state, actor, "1x4");
      if (state.removed.has(rec.id)) this._setControlRemoved(state, actor, rec, true);
    }

    if (!state.cellLayout) {
      const spans = new Map(grid.get_children().map(actor => [actor,
        grid.layout_manager.get_child_meta(grid, actor).columnSpan ?? 1]));
      state.cellLayout = new OriginUICCControlLayout(state, state.originalLayout);
      grid.layout_manager = state.cellLayout;
      for (const [actor, span] of spans)
        grid.layout_manager.child_set_property(grid, actor, "column-span", span);
    }

    this._setupPanelViewport(state);
    this._styleSystemActions(state);
    this._syncPanelHeight(state);
    const signature = [...state.actors, ...state.sliders].map(([, rec]) => rec.id).sort().join("|");
    const fixedSignature = state.fixedActors.map(actor => this._controlId(actor)).sort().join("|");
    const inventoryChanged = signature !== state.signature || fixedSignature !== state.fixedSignature;
    if (!inventoryChanged) state.stablePasses++;
    else {
      state.signature = signature;
      state.fixedSignature = fixedSignature;
      state.stablePasses = 0;
      state.savedApplied = false;
      this._reorderGrid(state);
    }
    if (!state.editing && !state.savedApplied && state.stablePasses >= 1 && (!this._defaultLayoutPending || state.actors.size > 0)) {
      if (this._defaultLayoutPending) {
        // Fresh and pre-v4 layouts start with only brightness/volume and
        // system actions visible; user toggles remain available in Gallery.
        for (const [actor, rec] of state.actors) {
          this._setTileSize(state, actor, "2x1");
          this._setControlRemoved(state, actor, rec, true);
        }
        this._savedLayout = this._serializeLayout(state);
        this._savedRemoved = [...state.removed];
        this._writeLayout(this._savedLayout, this._savedRemoved);
        this._defaultLayoutPending = false;
      } else {
        if (this._savedLayout.length) this._applySerializedLayout(state, this._savedLayout);
        for (const [actor, rec] of [...state.actors, ...state.sliders])
          if (state.removed.has(rec.id)) this._setControlRemoved(state, actor, rec, true);
      }
      state.savedApplied = true;
    }
    if (menu.isOpen) this._maybeShowAssistant(state);
  }

  _makeToolbarButton(label) {
    const button = new St.Button({style_class: "originuicc-add-control-button", can_focus: true});
    const row = new St.BoxLayout({style_class: "originuicc-toolbar-button-content", x_align: Clutter.ActorAlign.CENTER});
    const plus = this._extension?.dir?.get_child("control-add.svg");
    row.add_child(plus?.query_exists(null)
      ? new St.Icon({gicon: new Gio.FileIcon({file: plus}), icon_size: 16, style_class: "originuicc-add-control-icon"})
      : new St.Icon({icon_name: "list-add-symbolic", icon_size: 16}));
    row.add_child(new St.Label({text: label}));
    button.set_child(row);
    return button;
  }

  _createControlEditIcons(state, actor, rec, resizable = true) {
    if (resizable) {
      const gripFile = this._extension?.dir?.get_child("control-resize-arrow.svg");
      const icon = gripFile?.query_exists(null)
        ? new St.Icon({gicon: new Gio.FileIcon({file: gripFile}), icon_size: 28})
        : new St.Label({text: "↗"});
      rec.handle = new St.Button({child: icon, style_class: "originuicc-resize-grip", can_focus: true, visible: false});
      state.gripLayer.add_child(rec.handle);
      rec.handle.opacity = 0;
      rec.handle.connect("clicked", () => this._cycleTileSize(state, actor, rec));
    } else {
      rec.handle = null;
    }
    rec.removeButton = new St.Button({style_class: "originuicc-remove-control", child: new St.Icon({icon_name: "list-remove-symbolic", icon_size: 16}), can_focus: true, visible: false});
    state.gripLayer.add_child(rec.removeButton);
    rec.removeButton.connect("clicked", () => this._removeControl(state, actor, rec));
    rec.allocId = actor.connect("notify::allocation", () => this._queueEditorHandles(state));
    rec.transformIds = ["scale-x", "scale-y", "translation-x", "translation-y"]
      .map(property => actor.connect(`notify::${property}`, () => this._queueEditorHandles(state)));
    rec.pressIds = [actor, this._toggleContents(actor)].filter((widget, index, widgets) => widgets.indexOf(widget) === index)
      .map(widget => [widget, widget.connect("button-press-event", (_actor, event) => this._editorDragEvent(state, event))]);
  }

  _cycleTileSize(state, actor, rec) {
    if (!state.editing || rec.removed) return;
    const cycle = ["2x1", "2x2", "1x1"];
    const index = cycle.indexOf(rec.size);
    const nextSize = cycle[(index + 1) % cycle.length];
    if (!this._fitsTileGrid(state, null, actor, nextSize)) {
      this._showMaxControlsDialog(state);
      return;
    }
    const order = state.grid.get_children().filter(child => state.actors.has(child) || state.sliders.has(child));
    this._animateGridReorder(state, order, null, () => this._setTileSize(state, actor, nextSize));
  }

  _reorderGrid(state, preferredOrder = null) {
    const fixed = (state.fixedActors ?? []).filter(actor => actor.get_parent?.() === state.grid);
    const active = preferredOrder ?? state.grid.get_children().filter(actor => {
      const rec = state.actors.get(actor) ?? state.sliders.get(actor);
      return rec && !rec.removed;
    });
    const keep = new Set([...fixed, ...active]);
    const rest = state.grid.get_children().filter(actor => !keep.has(actor));
    [...fixed, ...active, ...rest].forEach((actor, index) => {
      try { state.grid.set_child_at_index(actor, index); } catch (_) {}
    });
    state.grid.queue_relayout();
    this._queuePanelFit(state);
  }

  _setControlRemoved(state, actor, rec, removed) {
    rec.removed = removed;
    if (removed) {
      state.removed.add(rec.id);
      this._setResizeGripVisible(rec.handle, false);
      this._setResizeGripVisible(rec.removeButton, false);
      if (actor.get_parent?.() === state.grid) state.grid.remove_child(actor);
      actor.hide();
    } else {
      state.removed.delete(rec.id);
      if (actor.get_parent?.() !== state.grid) state.grid.add_child(actor);
      actor.show();
      this._reorderGrid(state);
    }
    this._refreshControlGallery(state);
  }

  _removeControl(state, actor, rec) {
    if (!state.editing || rec.removed || rec.removing) return;
    rec.removing = true;
    actor.remove_all_transitions();
    actor.ease({scale_x: 0.82, scale_y: 0.82, opacity: 0, duration: 170, mode: Clutter.AnimationMode.EASE_IN_QUAD, onComplete: () => {
      if (actor.is_destroyed?.()) return;
      rec.removing = false;
      actor.scale_x = 1;
      actor.scale_y = 1;
      actor.opacity = 255;
      this._setControlRemoved(state, actor, rec, true);
      this._reorderGrid(state);
    }});
  }

  _restoreControl(state, actor, rec) {
    if (!state.editing || !rec.removed) return false;
    if (!this._fitsTileGrid(state, null, actor, "2x1")) {
      this._showMaxControlsDialog(state);
      return false;
    }
    const parent = actor.get_parent?.();
    if (parent && parent !== state.grid) parent.remove_child(actor);
    actor.remove_all_transitions();
    actor.reactive = true;
    actor.set_pivot_point(0.5, 0.5);
    actor.scale_x = 0.84;
    actor.scale_y = 0.84;
    actor.opacity = 0;
    if (state.sliders.has(actor)) {
      rec.size = "1x4";
      this._setControlRemoved(state, actor, rec, false);
      this._setSliderSize(state, actor, "1x4");
    } else {
      rec.size = "2x1";
      this._setControlRemoved(state, actor, rec, false);
      this._setTileSize(state, actor, "2x1");
    }
    actor.ease({scale_x: 1, scale_y: 1, opacity: 255, duration: 190, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
      onComplete: () => this._positionResizeGrip(state, actor, rec.handle, rec.removeButton)});
    this._refreshControlGallery(state);
    return true;
  }

  _controlLabel(actor, rec) {
    const direct = [actor?._title?.text, actor?.accessible_name, actor?.accessibleName]
      .find(value => typeof value === "string" && value.trim());
    if (direct) return direct.trim();
    const labels = [];
    const visit = widget => {
      if (widget instanceof St.Label && widget.text?.trim()) labels.push(widget.text.trim());
      for (const child of widget?.get_children?.() ?? []) visit(child);
    };
    visit(actor);
    const unique = [...new Set(labels)];
    if (unique.length) return unique[0];
    const idLabel = rec.id.split(":").slice(1).join(":").trim();
    return idLabel || "Control";
  }

  _openControlGallery(state) {
    this._closeControlGallery(state);
    const panel = new St.BoxLayout({vertical: true, style_class: "originuicc-control-gallery", reactive: true});
    const header = new St.BoxLayout({style_class: "originuicc-gallery-header"});
    header.add_child(new St.Label({text: "Control Gallery", x_expand: true, style_class: "originuicc-gallery-title"}));
    const close = new St.Button({child: new St.Icon({icon_name: "window-close-symbolic", icon_size: 16}), style_class: "originuicc-gallery-close", can_focus: true});
    header.add_child(close);
    panel.add_child(header);
    panel.add_child(new St.Label({text: "Add removed controls back to Quick Settings.", style_class: "originuicc-gallery-description"}));
    const list = new St.BoxLayout({vertical: true, style_class: `quick-settings originuicc-gallery-list ${this._getColorSchemeClass()}`});
    const scroll = new St.ScrollView({style_class: "originuicc-gallery-scroll", x_expand: true, y_expand: true, reactive: true, can_focus: true, enable_mouse_scrolling: true, overlay_scrollbars: false});
    scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
    scroll.set_child(list);
    panel.add_child(scroll);
    // Keep the gallery inside the Quick Settings popup's input scope while
    // allowing it to draw outside the menu's visual bounds.
    const host = new St.Widget({layout_manager: new Clutter.FixedLayout(), reactive: false, width: 1, height: 1});
    host.set_position(0, 0);
    host.set_size(1, 1);
    host.set_clip_to_allocation(false);
    state.menu.actor.add_child(host);
    state.galleryHost = host;
    host.add_child(panel);
    const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
    const monitor = Main.layoutManager.findMonitorForActor(state.menu.actor) ?? Main.layoutManager.primaryMonitor;
    const panelWidth = Math.min(580 * scale, monitor.width - 48 * scale);
    const panelHeight = Math.min(520 * scale, monitor.height - 64 * scale);
    const panelX = monitor.x + (monitor.width - panelWidth) / 2;
    const panelY = monitor.y + (monitor.height - panelHeight) / 2;
    const [menuX, menuY] = state.menu.actor.get_transformed_position();
    panel.set_size(panelWidth, panelHeight);
    scroll.set_size(panelWidth - 48 * scale, panelHeight - 150 * scale);
    panel.set_position(panelX - menuX, panelY - menuY);
    panel.translation_y = 48;
    panel.opacity = 0;
    state.menu.actor.set_child_above_sibling(host, null);
    panel.ease({translation_y: 0, opacity: 255, duration: 260, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    close.connect("clicked", () => {
      this._closeControlGallery(state);
      GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        if (state.editing && !state.menu.isOpen) state.menu.open();
        return GLib.SOURCE_REMOVE;
      });
    });
    state.galleryPanel = panel;
    state.galleryList = list;
    state.galleryDialog = true;
    this._refreshControlGallery(state);
  }

  _refreshControlGallery(state) {
    if (state.galleryRefreshPending) return;
    state.galleryRefreshPending = true;
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      state.galleryRefreshPending = false;
      const list = state.galleryList;
      if (!list || list.is_destroyed?.()) return GLib.SOURCE_REMOVE;
      for (const child of list.get_children()) {
        list.remove_child(child);
        child.destroy();
      }
      const removed = [...state.actors, ...state.sliders].filter(([, rec]) => rec.removed);
      if (!removed.length) {
        list.add_child(new St.Label({text: "All available controls are already in Quick Settings."}));
        return GLib.SOURCE_REMOVE;
      }
      const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
      for (let index = 0; index < removed.length; index += 2) {
        const row = new St.BoxLayout({style_class: "originuicc-gallery-row", x_expand: true});
        row.layout_manager.homogeneous = true;
        const entries = removed.slice(index, index + 2);
        for (const [actor, rec] of entries) {
          const source = this._toggleContents(actor)._icon ?? actor._icon;
          const label = this._controlLabel(actor, rec);
          const pill = new QuickToggle({title: label, checked: !!actor.checked, toggle_mode: true,
            style_class: "quick-toggle button originuicc-tile originuicc-size-2x1 originuicc-gallery-pill",
            accessible_name: `Add ${label}`, can_focus: true, x_expand: true, height: 64 * scale});
          if (source?.gicon) pill.gicon = source.gicon;
          else pill.icon_name = source?.icon_name ?? actor.icon_name ?? "preferences-system-symbolic";
          pill._icon.icon_size = 20;
          pill._icon.y_align = Clutter.ActorAlign.CENTER;
          pill._box.add_child(new St.Icon({icon_name: "list-add-symbolic", icon_size: 16,
            style_class: "originuicc-gallery-add-icon", y_align: Clutter.ActorAlign.CENTER}));
          pill.connect("clicked", () => this._restoreControl(state, actor, rec));
          row.add_child(pill);
        }
        if (entries.length === 1) row.add_child(new St.Widget({x_expand: true}));
        list.add_child(row);
      }
      return GLib.SOURCE_REMOVE;
    });
  }

  _closeControlGallery(state) {
    const host = state.galleryHost;
    state.galleryPanel = null;
    state.galleryList = null;
    state.galleryHost = null;
    state.galleryDialog = null;
    if (!host) return;
    try { state.menu.actor.remove_child(host); host.destroy(); } catch (_) {}
  }

  _resetLayout(state) {
    if (!state.editing) return;
    this._resetEditorActors(state);
    state.removed.clear();
    for (const [actor, rec] of state.sliders) {
      rec.removed = false;
      if (actor.get_parent?.() !== state.grid) state.grid.add_child(actor);
      actor.show();
      this._setSliderSize(state, actor, "1x4");
    }
    for (const [actor, rec] of state.actors) {
      this._setTileSize(state, actor, "2x1");
      rec.removed = true;
      rec.removing = false;
      state.removed.add(rec.id);
      this._setResizeGripVisible(rec.handle, false);
      this._setResizeGripVisible(rec.removeButton, false);
      actor.reactive = true;
      actor.remove_all_transitions();
      actor.scale_x = 1;
      actor.scale_y = 1;
      actor.opacity = 255;
      if (actor.get_parent?.() === state.grid) state.grid.remove_child(actor);
      actor.hide();
    }
    const order = state.initialOrder.filter(actor => state.sliders.has(actor));
    this._reorderGrid(state, order);
    this._refreshControlGallery(state);
  }

  _queueEditorHandles(state) {
    if (!state.editing || state.restoring || state.destroyed || state.handlesLater || state.reflowLater) return;
    state.handlesLater = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
      state.handlesLater = 0;
      if (!state.editing || state.restoring || state.destroyed) return GLib.SOURCE_REMOVE;
      for (const [actor, rec] of [...state.actors, ...state.sliders])
        if (!rec.removed && actor.get_parent?.() === state.grid)
          this._positionResizeGrip(state, actor, rec.handle, rec.removeButton);
      return GLib.SOURCE_REMOVE;
    });
  }

  _positionResizeGrip(state, actor, grip, removeButton = null) {
    if (state.restoring || !state.editing || !actor || actor.is_destroyed?.() || (!grip && !removeButton)) return;
    const [x, y] = actor.get_transformed_position();
    const [width, height] = actor.get_transformed_size();
    const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
    let view = null;
    if (state.panelViewport) {
      const [vx, vy] = state.panelViewport.get_transformed_position();
      const [vw, vh] = state.panelViewport.get_transformed_size();
      view = {x: vx, y: vy, width: vw, height: vh};
    }
    const showAt = (button, bx, by) => {
      const fits = !view || (bx >= view.x && by >= view.y && bx + button.width <= view.x + view.width && by + button.height <= view.y + view.height);
      button.visible = fits;
      return fits;
    };
    if (grip && !grip.is_destroyed?.()) {
      grip.translation_x = grip.translation_y = 0;
      const sx = x + width - (grip.width || 28 * scale) + 5 * scale;
      const sy = y + height - (grip.height || 28 * scale) + 5 * scale;
      if (showAt(grip, sx, sy)) {
        const [ok, localX, localY] = state.gripLayer.transform_stage_point(sx, sy);
        if (ok) grip.set_position(localX, localY);
      }
    }
    if (removeButton && !removeButton.is_destroyed?.()) {
      removeButton.translation_x = removeButton.translation_y = 0;
      const sx = x - scale, sy = y - scale;
      if (showAt(removeButton, sx, sy)) {
        const [ok, localX, localY] = state.gripLayer.transform_stage_point(sx, sy);
        if (ok) removeButton.set_position(localX, localY);
      }
    }
  }

  _setupPanelViewport(state) {
    if (state.panelViewport) return;
    const bin = state.menu._boxPointer?.bin;
    if (!bin || bin.get_child() !== state.menu.box) return;
    const viewport = new St.ScrollView({style_class: "originuicc-panel-viewport",
      reactive: true, enable_mouse_scrolling: true, overlay_scrollbars: false});
    viewport.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
    viewport.set_clip_to_allocation(true);
    bin.set_child(null);
    viewport.set_child(state.menu.box);
    bin.set_child(viewport);
    state.panelViewport = viewport;
    const adjustment = viewport.vadjustment ?? viewport.get_vadjustment?.()
      ?? viewport.get_vscroll_bar?.().get_adjustment();
    state.scrollAdjustment = adjustment;
    state.viewportSignals = [];
    if (adjustment) {
      state.viewportSignals.push([adjustment, adjustment.connect("notify::value", () => {
        // A submenu must not remain floating over controls that scroll away.
        state.menu._activeMenu?.close(false);
        this._queuePanelFit(state);
        this._queueEditorHandles(state);
      })]);
    }
    for (const property of ["x", "y", "translation-x", "translation-y"]) {
      const pointer = state.menu._boxPointer;
      state.viewportSignals.push([pointer, pointer.connect(`notify::${property}`, () => {
        this._queueEditorHandles(state);
      })]);
    }
    state.viewportSignals.push([state.menu.box, state.menu.box.connect("notify::height", () => this._queuePanelFit(state))]);
  }

  _queuePanelFit(state) {
    if (state.destroyed || state.restoring || state.fitLater) return;
    state.fitLater = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
      state.fitLater = 0;
      if (state.destroyed || state.restoring) return GLib.SOURCE_REMOVE;
      this._syncPanelHeight(state);
      const overlay = state.menu._overlay;
      if (overlay && state.menu.isOpen) {
        const offset = state.grid.apply_relative_transform_to_point(state.menu._boxPointer, new Graphene.Point3D());
        const binding = overlay.get_constraints().find(constraint =>
          constraint instanceof Clutter.BindConstraint && constraint.coordinate === Clutter.BindCoordinate.Y);
        if (binding && Math.abs(binding.offset - offset.y) > 0.5) binding.offset = offset.y;
      }
      this._queueEditorHandles(state);
      return GLib.SOURCE_REMOVE;
    });
  }

  _syncPanelHeight(state) {
    if (state.destroyed || state.restoring) return;
    const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
    const monitor = Main.layoutManager.findMonitorForActor(state.menu._boxPointer ?? state.menu.actor) ?? Main.layoutManager.primaryMonitor;
    const workArea = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
    state.rowLimit = 8;
    // Keep usable control sizes on scaled monitors; the viewport handles any
    // height beyond the work area without changing the 4x8 grid's capacity.
    const cell = 64 * scale;
    if (state.cellSize !== cell) {
      state.cellSize = cell;
      state.grid.queue_relayout();
    }
    if (state.panelViewport) {
      const available = Math.max(96 * scale, workArea.height - 40 * scale);
      const natural = state.menu.box.get_preferred_height(-1)[1];
      const height = Math.min(Math.max(1, natural), available);
      if (state.viewportHeight !== height) {
        state.viewportHeight = height;
        state.panelViewport.height = height;
      }
    }
  }

  _styleSystemActions(state) {
    state.systemRecords ??= new Map();
    for (const row of state.fixedActors ?? []) {
      if (!row.has_style_class_name?.("quick-settings-system-item")) continue;
      row.add_style_class_name("originuicc-system-row");
      const box = row.get_child?.() ?? row.child;
      for (const button of box?.get_children?.() ?? []) {
        if (!(button instanceof St.Button)) continue;
        let rec = state.systemRecords.get(button);
        if (!rec) {
          rec = {};
          state.systemRecords.set(button, rec);
          this._rememberPresentation(rec, button, ["x_expand", "y_expand", "x_align", "y_align"]);
        }
        button.add_style_class_name("originuicc-system-circle");
        button.x_expand = button.y_expand = false;
        button.x_align = button.y_align = Clutter.ActorAlign.CENTER;
        const content = button._box;
        if (content) {
          this._rememberPresentation(rec, content, ["x_expand", "y_expand", "x_align", "y_align"]);
          content.x_expand = content.y_expand = true;
          content.x_align = content.y_align = Clutter.ActorAlign.FILL;
          for (const child of content.get_children()) {
            if (child instanceof St.Icon) {
              this._rememberPresentation(rec, child, ["x_expand", "x_align", "y_align"]);
              child.x_expand = true;
              child.x_align = child.y_align = Clutter.ActorAlign.CENTER;
            } else {
              this._rememberPresentation(rec, child, ["visible"]);
              child.hide();
            }
          }
        }
      }
    }
  }

  _releaseEditorPointer(state) {
    if (state.pointerGrab) {
      state.pointerGrab.dismiss();
      state.pointerGrab = null;
    }
  }

  _setResizeGripVisible(grip, visible) {
    if (!grip || grip.is_destroyed?.()) return;
    if (visible && grip.visible && grip.opacity >= 250) return;
    if (!visible && !grip.visible) return;
    grip.remove_all_transitions();
    if (visible) {
      grip.opacity = 0;
      grip.scale_x = 0.78;
      grip.scale_y = 0.78;
      grip.show();
      grip.ease({opacity: 255, scale_x: 1, scale_y: 1, duration: 160, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    } else {
      grip.ease({opacity: 0, scale_x: 0.82, scale_y: 0.82, duration: 110, mode: Clutter.AnimationMode.EASE_IN_QUAD, onComplete: () => grip.hide()});
    }
  }

  _maybeShowAssistant(state) {
    if (!state.assistantShown && !this._assistantSeen()) {
      state.assistantShown = true;
      this._showAssistant(state);
    }
  }

  _assistantSeen() {
    try { const [, bytes] = GLib.file_get_contents(this._layoutFile); return JSON.parse(new TextDecoder().decode(bytes)).assistantVersion === this._assistantVersion; }
    catch (_) { return false; }
  }

  _showAssistant(state) {
    const panel = new St.BoxLayout({vertical: true, style_class: "originuicc-control-gallery originuicc-whats-new", reactive: true});
    const header = new St.BoxLayout({style_class: "originuicc-gallery-header"});
    header.add_child(new St.Label({text: "What's new in Quick Settings", x_expand: true, style_class: "originuicc-gallery-title"}));
    panel.add_child(header);

    const instructions = [
      "Add controls in the Control Gallery",
      "Resize Quick Settings toggles by pressing the resize button",
      "Move toggles around and arrange your Quick Settings to your liking",
    ];
    const list = new St.BoxLayout({vertical: true, style_class: "originuicc-whats-new-list"});
    const scroll = new St.ScrollView({style_class: "originuicc-gallery-scroll", x_expand: true, y_expand: true, reactive: true, can_focus: true, enable_mouse_scrolling: true, overlay_scrollbars: false});
    scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
    scroll.set_child(list);
    for (const instruction of instructions) {
      const item = new St.BoxLayout({style_class: "originuicc-whats-new-item"});
      item.add_child(new St.Label({text: instruction, x_expand: true, style_class: "originuicc-whats-new-copy"}));
      list.add_child(item);
    }
    panel.add_child(scroll);
    const done = new St.Button({label: "Got it", style_class: "originuicc-whats-new-done", can_focus: true});
    panel.add_child(done);

    const host = new St.Widget({layout_manager: new Clutter.FixedLayout(), reactive: false, width: 1, height: 1});
    host.set_position(0, 0);
    host.set_size(1, 1);
    host.set_clip_to_allocation(false);
    state.menu.actor.add_child(host);
    host.add_child(panel);
    state.assistantHost = host;
    state.assistantPanel = panel;

    const panelWidth = Math.min(620, global.stage.width - 48);
    const panelHeight = Math.min(520, global.stage.height - 64);
    const [menuX, menuY] = state.menu.actor.get_transformed_position();
    panel.set_size(panelWidth, panelHeight);
    scroll.set_size(panelWidth - 48, panelHeight - 150);
    panel.set_position((global.stage.width - panelWidth) / 2 - menuX, (global.stage.height - panelHeight) / 2 - menuY);
    panel.translation_y = 48;
    panel.opacity = 0;
    state.menu.actor.set_child_above_sibling(host, null);
    panel.ease({translation_y: 0, opacity: 255, duration: 260, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    done.connect("clicked", () => {
      this._writeLayout(this._serializeLayout(state), [...state.removed], this._assistantVersion);
      this._closeAssistant(state);
    });
  }

  _closeAssistant(state) {
    const host = state.assistantHost;
    const panel = state.assistantPanel;
    state.assistantHost = null;
    state.assistantPanel = null;
    if (!host) return;
    const destroy = () => {
      try { state.menu.actor.remove_child(host); host.destroy(); } catch (_) {}
    };
    if (panel && !panel.is_destroyed?.())
      panel.ease({translation_y: 24, opacity: 0, duration: 150, mode: Clutter.AnimationMode.EASE_IN_QUAD, onComplete: destroy});
    else
      destroy();
  }

  _completePendingRemovals(state) {
    for (const [actor, rec] of [...state.actors, ...state.sliders]) {
      if (!rec.removing) continue;
      actor.remove_all_transitions();
      actor.scale_x = actor.scale_y = 1;
      actor.opacity = 255;
      rec.removing = false;
      this._setControlRemoved(state, actor, rec, true);
    }
  }

  _serializeLayout(state) {
    this._completePendingRemovals(state);
    const visible = state.grid.get_children().filter(a => state.actors.has(a) || state.sliders.has(a));
    const removed = state.initialOrder.filter(a => (state.actors.get(a) ?? state.sliders.get(a))?.removed);
    return [...visible, ...removed].map(a => {
      const r = state.actors.get(a) ?? state.sliders.get(a);
      return {id: r.id, size: r.size};
    });
  }

  _tileDimensions(size) {
    switch (size) {
      case "1x1": return [1, 1];
      case "2x2": return [2, 2];
      case "2x1":
      default: return [2, 1];
    }
  }

  _normalizeTileSize(size) {
    if (size === "1x1" || size === "2x1" || size === "2x2") return size;
    if (size === "1x2" || size === "4x1") return "2x1";
    if (size === "2x4" || size === "4x2") return "2x2";
    return "2x1";
  }

  _fitsTileGrid(state, order = null, extraActor = null, extraSize = null) {
    const rowLimit = 8;
    const cells = Array.from({length: rowLimit}, () => Array(4).fill(false));
    const actors = order ?? state.grid.get_children().filter(actor => {
      const rec = state.actors.get(actor) ?? state.sliders.get(actor);
      return rec && !rec.removed;
    });
    const entries = [...actors];
    if (extraActor && !entries.includes(extraActor)) entries.push(extraActor);
    for (const actor of entries) {
      const rec = state.actors.get(actor) ?? state.sliders.get(actor);
      if (!rec || (rec.removed && actor !== extraActor)) continue;
      const size = actor === extraActor && extraSize ? extraSize : rec.size;
      const [width, height] = state.sliders.has(actor) ? [4, 1] : this._tileDimensions(size);
      let placed = false;
      for (let row = 0; row <= rowLimit - height && !placed; row++) {
        for (let column = 0; column <= 4 - width && !placed; column++) {
          let free = true;
          for (let y = row; y < row + height && free; y++)
            for (let x = column; x < column + width; x++)
              if (cells[y][x]) { free = false; break; }
          if (!free) continue;
          for (let y = row; y < row + height; y++)
            for (let x = column; x < column + width; x++) cells[y][x] = true;
          placed = true;
        }
      }
      if (!placed) return false;
    }
    return true;
  }

  _showMaxControlsDialog(state) {
    if (state.limitHost) return;
    const panel = new St.BoxLayout({vertical: true, style_class: "originuicc-limit-dialog", reactive: true});
    for (const [text, style_class] of [
      ["Maximum number of toggles reached", "originuicc-limit-title"],
      ["Remove a toggle or choose a smaller size to make room.", "originuicc-limit-message"],
    ]) {
      const label = new St.Label({text, style_class});
      label.clutter_text.line_wrap = true;
      panel.add_child(label);
    }
    const okay = new St.Button({label: "Okay", style_class: "originuicc-limit-okay", can_focus: true});
    panel.add_child(okay);
    const host = new St.Widget({layout_manager: new Clutter.FixedLayout(), reactive: false, width: 1, height: 1});
    host.set_position(0, 0);
    host.set_size(1, 1);
    host.set_clip_to_allocation(false);
    state.menu.actor.add_child(host);
    host.add_child(panel);
    state.limitHost = host;
    state.limitPanel = panel;
    state.limitDialog = true;
    const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
    const monitor = Main.layoutManager.findMonitorForActor(state.menu._boxPointer ?? state.menu.actor) ?? Main.layoutManager.primaryMonitor;
    const area = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
    const width = Math.min(420 * scale, area.width - 48 * scale);
    const [menuX, menuY] = state.menu.actor.get_transformed_position();
    panel.width = width;
    panel.ensure_style();
    const height = panel.get_preferred_height(width)[1];
    panel.set_position(area.x + (area.width - width) / 2 - menuX, area.y + (area.height - height) / 2 - menuY);
    panel.opacity = 0;
    panel.translation_y = 20;
    state.menu.actor.set_child_above_sibling(host, null);
    panel.ease({opacity: 255, translation_y: 0, duration: 180, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    okay.connect("clicked", () => {
      if (state.limitClosing) return;
      state.limitClosing = true;
      okay.reactive = false;
      panel.ease({opacity: 0, translation_y: 8, duration: 120, mode: Clutter.AnimationMode.EASE_IN_QUAD,
        onComplete: () => this._closeMaxControlsDialog(state)});
    });
  }

  _closeMaxControlsDialog(state) {
    const host = state.limitHost;
    state.limitHost = null;
    state.limitPanel = null;
    state.limitDialog = false;
    state.limitClosing = false;
    if (!host) return;
    try { state.menu.actor.remove_child(host); host.destroy(); } catch (_) {}
  }

  _setCompactArrowVisibility(actor, rec, visible) {
    if (!rec || !actor) return;
    rec.arrowStates ??= new Map();
    const targets = new Set();
    const visit = widget => {
      const classes = widget?.get_style_class_name?.() ?? "";
      if (/(^|\s)(quick-toggle-arrow-button|quick-toggle-menu-button|quick-toggle-arrow|quick-toggle-separator)(\s|$)/.test(classes)) {
        const parent = widget.get_parent?.();
        const parentClasses = parent?.get_style_class_name?.() ?? "";
        targets.add(/(^|\s)(quick-toggle-arrow-button|quick-toggle-menu-button)(\s|$)/.test(classes)
          ? widget
          : (/(^|\s)(quick-toggle-arrow-button|quick-toggle-menu-button)(\s|$)/.test(parentClasses) ? parent : widget));
      }
      for (const child of widget?.get_children?.() ?? []) visit(child);
    };
    visit(actor);
    for (const target of targets) {
      if (!rec.arrowStates.has(target))
        rec.arrowStates.set(target, {visible: target.visible, reactive: target.reactive});
      const original = rec.arrowStates.get(target);
      const isMenuPart = target === actor._menuButton || target.has_style_class_name?.("quick-toggle-separator");
      const menuVisible = isMenuPart ? actor.menuEnabled !== false : original.visible;
      target.visible = visible && menuVisible;
      target.reactive = visible ? original.reactive : false;
    }
    // Menu-button visibility is bound to separator visibility by Shell. Hide
    // separators after changing that button, including in the pill size.
    for (const target of targets)
      if (target.has_style_class_name?.("quick-toggle-separator")) target.hide();
  }

  _rememberPresentation(rec, widget, properties) {
    if (!widget) return;
    rec.presentationStates ??= new Map();
    const original = rec.presentationStates.get(widget) ?? {};
    for (const property of properties)
      if (!(property in original)) original[property] = widget[property];
    rec.presentationStates.set(widget, original);
  }

  _toggleContents(actor) {
    if (actor?._icon instanceof St.Icon) return actor;
    return actor?._box?.get_children?.().find(child => child._icon instanceof St.Icon) ?? actor;
  }

  _setTileSize(state, actor, size) {
    size = this._normalizeTileSize(size);
    const rec = state.actors.get(actor);
    if (!rec) return;
    rec.size = size;
    for (const name of ["1x1", "2x1", "2x2"]) actor.remove_style_class_name(`originuicc-size-${name}`);
    actor.add_style_class_name("originuicc-tile");
    actor.add_style_class_name(`originuicc-size-${size}`);
    if (actor.get_parent?.() === state.grid)
      state.grid.layout_manager.child_set_property(state.grid, actor, "column-span", this._tileDimensions(size)[0]);
    const compact = size === "1x1";
    const large = size === "2x2";
    this._setCompactArrowVisibility(actor, rec, size === "2x1");
    if (!rec.menuEnabledId && actor._menuButton) {
      rec.menuEnabledId = actor.connect("notify::menu-enabled", () =>
        this._setCompactArrowVisibility(actor, rec, rec.size === "2x1"));
    }
    const contents = this._toggleContents(actor);
    const box = contents._box;
    for (const widget of [actor, contents, actor._box, box]) {
      if (!widget) continue;
      this._rememberPresentation(rec, widget, ["x_expand", "y_expand", "x_align", "y_align"]);
      widget.x_expand = true;
      widget.y_expand = true;
      widget.x_align = Clutter.ActorAlign.FILL;
      widget.y_align = Clutter.ActorAlign.FILL;
    }
    if (box) {
      this._rememberPresentation(rec, box, ["vertical"]);
      box.vertical = large;
    }
    const icon = contents._icon;
    if (icon) {
      this._rememberPresentation(rec, icon, ["icon_size", "x_expand", "y_expand", "x_align", "y_align"]);
      icon.icon_size = 20;
      icon.x_expand = compact || large;
      icon.y_expand = large;
      icon.x_align = compact ? Clutter.ActorAlign.CENTER : Clutter.ActorAlign.START;
      icon.y_align = large ? Clutter.ActorAlign.START : Clutter.ActorAlign.CENTER;
    }
    const titleBox = box?.get_children?.().find(child => child !== icon && child instanceof St.BoxLayout);
    if (titleBox) {
      this._rememberPresentation(rec, titleBox, ["visible", "x_expand", "y_expand", "x_align", "y_align"]);
      titleBox.visible = compact ? false : rec.presentationStates.get(titleBox).visible;
      titleBox.x_expand = true;
      titleBox.y_expand = false;
      titleBox.x_align = Clutter.ActorAlign.FILL;
      titleBox.y_align = large ? Clutter.ActorAlign.END : Clutter.ActorAlign.CENTER;
      for (const label of titleBox.get_children()) {
        this._rememberPresentation(rec, label, ["x_align"]);
        label.x_align = large ? Clutter.ActorAlign.END : Clutter.ActorAlign.START;
      }
    }
    state.grid.queue_relayout();
    if (rec.handle) this._setResizeGripVisible(rec.handle, state.editing && !rec.removed);
    if (rec.removeButton) this._setResizeGripVisible(rec.removeButton, state.editing && !rec.removed);
  }

  _setSliderSize(state, actor, size = "1x4") {
    // Brightness and volume remain full-width, standard-height controls. They
    // can move in the grid but intentionally have no resize handle.
    size = "1x4";
    const span = 4;
    const columns = Math.max(1, state.grid.layout_manager.nColumns ?? state.grid.layout_manager.n_columns ?? 4);
    const rec = state.sliders.get(actor);
    if (rec) rec.size = size;
    actor.remove_style_class_name("originuicc-slider-size-1x2");
    actor.remove_style_class_name("originuicc-slider-size-1x4");
    actor.add_style_class_name(`originuicc-slider-size-${size}`);
    if (actor.get_parent?.() === state.grid) {
      try { state.grid.layout_manager.child_set_property(state.grid, actor, "column-span", Math.min(span, columns)); } catch (_) {}
    }
    if (rec?.handle) this._setResizeGripVisible(rec.handle, state.editing && !rec.removed);
    if (rec?.removeButton) this._setResizeGripVisible(rec.removeButton, state.editing && !rec.removed);
  }

  _enterEditMode(state) {
    if (state.editing) return;
    state.saved = this._serializeLayout(state);
    state.savedRemoved = [...state.removed];
    state.editing = true;
    state.grid.add_style_class_name("originuicc-editing");
    state.button.hide();
    state.toolbar.show();
    for (const [actor, rec] of [...state.actors, ...state.sliders]) {
      if (rec.removed) continue;
      this._stopAnimation(actor, true);
      actor.remove_all_transitions();
      actor.translation_x = actor.translation_y = 0;
      actor.scale_x = actor.scale_y = 1;
      this._positionResizeGrip(state, actor, rec.handle, rec.removeButton);
      if (rec.handle) this._setResizeGripVisible(rec.handle, true);
      this._setResizeGripVisible(rec.removeButton, true);
    }
    try { state.menu.actor.set_child_above_sibling(state.gripLayer, null); } catch (_) {}
    state.captureId = state.grid.connect("captured-event", (_grid, event) => this._editorDragEvent(state, event));
    state.dragEventActor = new St.Widget({reactive: true, width: 1, height: 1});
    state.menu.actor.add_child(state.dragEventActor);
    state.dragEventId = state.dragEventActor.connect("event", (_actor, event) => this._editorDragEvent(state, event));
    this._syncPanelHeight(state);
  }

  _pointInside(actor, stageX, stageY) {
    if (!actor || actor.is_destroyed?.() || !actor.visible) return false;
    try {
      const [hit, x, y] = actor.transform_stage_point(stageX, stageY);
      return hit && x >= 0 && y >= 0 && x <= actor.width && y <= actor.height;
    } catch (_) {
      return false;
    }
  }

  _cancelGridReflow(state) {
    if (state.handlesLater) {
      global.compositor.get_laters().remove(state.handlesLater);
      state.handlesLater = 0;
    }
    if (state.reflowLater) {
      global.compositor.get_laters().remove(state.reflowLater);
      state.reflowLater = 0;
    }
  }

  _animateGridReorder(state, preferredOrder, drag = null, change = null) {
    if (!this._fitsTileGrid(state, preferredOrder)) return false;
    this._cancelGridReflow(state);
    const before = new Map();
    for (const [actor, rec] of [...state.actors, ...state.sliders]) {
      if (rec.removed || rec.removing || actor.get_parent?.() !== state.grid) continue;
      this._stopAnimation(actor, false);
      if (actor !== drag?.actor) {
        const [x, y] = actor.get_transformed_position();
        const [width, height] = actor.get_transformed_size();
        before.set(actor, {x, y, width, height});
      }
      actor.remove_all_transitions();
      actor.set_pivot_point(0, 0);
      actor.translation_x = 0;
      actor.translation_y = 0;
      actor.scale_x = actor.scale_y = 1;
      for (const button of [rec.handle, rec.removeButton]) {
        if (!button || button.is_destroyed?.()) continue;
        button.remove_all_transitions();
        button.translation_x = button.translation_y = 0;
        button.scale_x = button.scale_y = 1;
        if (button.visible) button.opacity = 255;
      }
    }
    change?.();
    this._reorderGrid(state, preferredOrder);
    if (drag) drag.reorderPending = true;
    state.reflowLater = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
      state.reflowLater = 0;
      if (state.destroyed || !state.editing) return GLib.SOURCE_REMOVE;
      state.slotRects = new Map();
      for (const [actor, rec] of [...state.actors, ...state.sliders]) {
        if (rec.removed || actor.get_parent?.() !== state.grid) continue;
        const [x, y] = actor.get_transformed_position();
        const [width, height] = actor.get_transformed_size();
        state.slotRects.set(actor, {x, y, width, height});
        const old = before.get(actor);
        this._positionResizeGrip(state, actor, rec.handle, rec.removeButton);
        if (!old || actor === drag?.actor || width <= 0 || height <= 0) continue;
        actor.translation_x = old.x - x;
        actor.translation_y = old.y - y;
        actor.scale_x = old.width / width;
        actor.scale_y = old.height / height;
        this._positionResizeGrip(state, actor, rec.handle, rec.removeButton);
        actor.ease({translation_x: 0, translation_y: 0, scale_x: 1, scale_y: 1,
          duration: 220, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
          onComplete: () => { if (!actor.is_destroyed?.()) actor.set_pivot_point(0.5, 0.5); }});
      }
      if (drag) {
        drag.reorderPending = false;
        this._positionDraggedActor(state, drag, drag.currentX, drag.currentY);
        if (drag.released) this._settleDraggedActor(state, drag);
      }
      return GLib.SOURCE_REMOVE;
    });
    return true;
  }

  _positionDraggedActor(state, drag, stageX, stageY) {
    const actor = drag.actor;
    if (!actor || actor.is_destroyed?.() || actor.get_parent?.() !== state.grid) return;
    actor.translation_x = 0;
    actor.translation_y = 0;
    const [baseX, baseY] = actor.get_transformed_position();
    actor.translation_x = stageX - drag.offsetX - baseX;
    actor.translation_y = stageY - drag.offsetY - baseY;
    this._positionResizeGrip(state, actor, drag.rec.handle, drag.rec.removeButton);
  }

  _findDragTarget(state, drag, stageX, stageY) {
    if (drag.reorderPending) return null;
    let nearest = null;
    for (const [actor, rect] of state.slotRects ?? []) {
      if (actor === drag.actor || actor.get_parent?.() !== state.grid) continue;
      const distance = Math.hypot(stageX - (rect.x + rect.width / 2), stageY - (rect.y + rect.height / 2));
      if (!nearest || distance < nearest.distance) nearest = {actor, distance};
    }
    return nearest?.actor ?? null;
  }

  _reorderDraggedActor(state, drag, stageX, stageY) {
    const target = this._findDragTarget(state, drag, stageX, stageY);
    if (!target) return;
    const rect = state.slotRects.get(target);
    const after = stageY < rect.y ? false : stageY > rect.y + rect.height ? true
      : (state.grid.text_direction === Clutter.TextDirection.RTL ? stageX < rect.x + rect.width / 2 : stageX > rect.x + rect.width / 2);
    if (target === drag.hoverTarget && after === drag.hoverAfter) return;
    const current = state.grid.get_children().filter(actor => {
      const rec = state.actors.get(actor) ?? state.sliders.get(actor);
      return rec && !rec.removed;
    });
    const order = current.filter(actor => actor !== drag.actor);
    const targetIndex = order.indexOf(target);
    if (targetIndex < 0) return;
    order.splice(targetIndex + (after ? 1 : 0), 0, drag.actor);
    drag.hoverTarget = target;
    drag.hoverAfter = after;
    if (!order.every((actor, index) => actor === current[index]))
      this._animateGridReorder(state, order, drag);
  }

  _settleDraggedActor(state, drag) {
    const actor = drag.actor;
    if (!actor || actor.is_destroyed?.() || actor.get_parent?.() !== state.grid) return;
    this._positionResizeGrip(state, actor, drag.rec.handle, drag.rec.removeButton);
    actor.ease({translation_x: 0, translation_y: 0, duration: 180, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
      onComplete: () => { if (!actor.is_destroyed?.()) actor.set_pivot_point(0.5, 0.5); }});
  }

  _editorDragEvent(state, event) {
    if (!state.editing || state.restoring || state.galleryDialog || state.confirmDialog || state.limitDialog)
      return Clutter.EVENT_PROPAGATE;
    const type = event.type();
    if (type === Clutter.EventType.KEY_PRESS && event.get_key_symbol() === Clutter.KEY_Escape && state.drag) {
      const drag = state.drag;
      state.drag = null;
      drag.released = true;
      this._releaseEditorPointer(state);
      if (!drag.reorderPending) this._settleDraggedActor(state, drag);
      return Clutter.EVENT_STOP;
    }
    if (type === Clutter.EventType.SCROLL && state.drag && state.panelViewport)
      return state.panelViewport.event(event, false);
    const [sx, sy] = event.get_coords?.() ?? [0, 0];
    if (type === Clutter.EventType.BUTTON_PRESS && state.panelViewport && !this._pointInside(state.panelViewport, sx, sy))
      return Clutter.EVENT_PROPAGATE;
    if (type === Clutter.EventType.BUTTON_PRESS && event.get_button() === 1 && !state.drag) {
      const controls = [...state.actors, ...state.sliders];
      if (controls.some(([, rec]) => this._pointInside(rec.handle, sx, sy) || this._pointInside(rec.removeButton, sx, sy)))
        return Clutter.EVENT_PROPAGATE;
      for (const [candidate, rec] of controls) {
        if (rec.removed || candidate.get_parent?.() !== state.grid || !this._pointInside(candidate, sx, sy)) continue;
        // Keep resize/remove buttons clickable instead of starting a tile drag.
        if (this._pointInside(rec.handle, sx, sy) || this._pointInside(rec.removeButton, sx, sy))
          return Clutter.EVENT_PROPAGATE;
        this._stopAnimation(candidate, true);
        candidate.remove_all_transitions();
        candidate.set_pivot_point(0, 0);
        candidate.scale_x = candidate.scale_y = 1;
        state.slotRects = new Map(controls.filter(([actor, rec]) => !rec.removed && actor.get_parent?.() === state.grid).map(([actor]) => {
          const [x, y] = actor.get_transformed_position();
          const [width, height] = actor.get_transformed_size();
          return [actor, {x: x - actor.translation_x, y: y - actor.translation_y, width: width / actor.scale_x, height: height / actor.scale_y}];
        }));
        const [actorX, actorY] = candidate.get_transformed_position();
        state.drag = {actor: candidate, rec, sx, sy, moved: false, offsetX: sx - actorX, offsetY: sy - actorY, currentX: sx, currentY: sy, hoverTarget: null, reorderPending: false, released: false};
        state.pointerGrab = global.stage.grab(state.dragEventActor);
        return Clutter.EVENT_STOP;
      }
      return Clutter.EVENT_PROPAGATE;
    }
    if (!state.drag) return Clutter.EVENT_PROPAGATE;
    const drag = state.drag;
    const {actor} = drag;
    if (type === Clutter.EventType.MOTION) {
      const dx = sx - drag.sx, dy = sy - drag.sy;
      if (drag.moved || Math.hypot(dx, dy) > 8) {
        drag.moved = true;
        drag.currentX = sx;
        drag.currentY = sy;
        this._positionDraggedActor(state, drag, sx, sy);
        this._reorderDraggedActor(state, drag, sx, sy);
        return Clutter.EVENT_STOP;
      }
      return Clutter.EVENT_PROPAGATE;
    }
    if (type !== Clutter.EventType.BUTTON_RELEASE || event.get_button() !== 1)
      return Clutter.EVENT_PROPAGATE;
    this._releaseEditorPointer(state);
    if (drag.moved) {
      drag.currentX = sx;
      drag.currentY = sy;
      this._positionDraggedActor(state, drag, sx, sy);
      this._reorderDraggedActor(state, drag, sx, sy);
      drag.released = true;
      state.drag = null;
      if (!drag.reorderPending) this._settleDraggedActor(state, drag);
    } else {
      state.drag = null;
      actor.translation_x = 0;
      actor.translation_y = 0;
      actor.set_pivot_point(0.5, 0.5);
    }
    return Clutter.EVENT_STOP;
  }

  _resetEditorActors(state) {
    this._cancelGridReflow(state);
    this._releaseEditorPointer(state);
    state.drag = null;
    for (const [actor, rec] of [...state.actors, ...state.sliders]) {
      this._stopAnimation(actor, false);
      actor.remove_all_transitions();
      actor.opacity = 255;
      actor.translation_x = actor.translation_y = 0;
      actor.scale_x = actor.scale_y = 1;
      actor.set_pivot_point(0.5, 0.5);
      rec.removing = false;
      for (const button of [rec.handle, rec.removeButton]) {
        if (!button) continue;
        button.remove_all_transitions();
        button.translation_x = button.translation_y = 0;
        button.scale_x = button.scale_y = 1;
      }
    }
  }

  _restoreEditorSnapshot(state) {
    state.restoring = true;
    this._resetEditorActors(state);
    state.menu._activeMenu?.close(false);
    // Stop edit hit testing and handle positioning before any actors change
    // parent. Allocation is deferred until the complete snapshot is installed.
    state.editing = false;
    this._setRemovedControls(state, state.savedRemoved ?? []);
    this._applySerializedLayout(state, state.saved ?? []);
    state.savedApplied = true;
    state.restoring = false;
  }

  _finishEdit(state) {
    if (state.confirmPanel || state.restoring) return;
    this._completePendingRemovals(state);
    this._releaseEditorPointer(state);
    if (state.drag) {
      state.drag.released = true;
      if (!state.drag.reorderPending) this._settleDraggedActor(state, state.drag);
    }
    state.drag = null;
    const panel = new St.BoxLayout({vertical: true, style_class: "originuicc-editor-confirm", x_expand: true});
    panel.add_child(new St.Label({text: "Save your changes?", x_expand: true,
      x_align: Clutter.ActorAlign.CENTER, style_class: "originuicc-confirm-title"}));
    const buttons = new St.BoxLayout({style_class: "originuicc-confirm-actions", x_expand: true});
    buttons.layout_manager.homogeneous = true;
    const discard = new St.Button({label: "Discard", style_class: "originuicc-confirm-discard", x_expand: true, can_focus: true});
    const save = new St.Button({label: "Save", style_class: "originuicc-confirm-save", x_expand: true, can_focus: true});
    buttons.add_child(discard);
    buttons.add_child(save);
    panel.add_child(buttons);
    state.actions.hide();
    state.doneButton.hide();
    state.toolbar.add_child(panel);
    state.confirmPanel = panel;
    state.confirmDialog = true;
    panel.opacity = 0;
    panel.translation_y = 8;
    panel.ease({opacity: 255, translation_y: 0, duration: 180, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    let closing = false;
    const finish = keepChanges => {
      if (closing) return;
      closing = true;
      state.exitAction = keepChanges;
      discard.reactive = save.reactive = false;
      panel.ease({opacity: 0, translation_y: 6, duration: 120, mode: Clutter.AnimationMode.EASE_IN_QUAD,
        onComplete: () => {
          // Never change the grid or destroy a button from its click emission.
          state.finishIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            state.finishIdle = 0;
            if (state.destroyed || !state.editing) return GLib.SOURCE_REMOVE;
            if (keepChanges) {
              this._resetEditorActors(state);
              this._savedLayout = this._serializeLayout(state);
              this._savedRemoved = [...state.removed];
              this._writeLayout(this._savedLayout, this._savedRemoved);
              state.savedApplied = true;
            } else {
              this._restoreEditorSnapshot(state);
            }
            this._closeEditor(state);
            return GLib.SOURCE_REMOVE;
          });
        }});
    };
    discard.connect("clicked", () => finish(false));
    save.connect("clicked", () => finish(true));
    this._syncPanelHeight(state);
  }

  _applySerializedLayout(state, layout) {
    for (const [actor, rec] of state.actors) {
      const entry = layout.find(x => x.id === rec.id);
      this._setTileSize(state, actor, this._normalizeTileSize(entry?.size));
    }
    for (const [actor] of state.sliders)
      this._setSliderSize(state, actor, "1x4");
    const ordered = layout.map(entry => [...state.actors, ...state.sliders].find(([, rec]) => rec.id === entry.id)?.[0]).filter(actor => actor && (state.actors.has(actor) || state.sliders.has(actor)) && !state.actors.get(actor)?.removed && !state.sliders.get(actor)?.removed);
    for (const actor of state.grid.get_children())
      if ((state.actors.has(actor) || state.sliders.has(actor)) && !state.actors.get(actor)?.removed && !state.sliders.get(actor)?.removed && !ordered.includes(actor)) ordered.push(actor);
    const accepted = [];
    for (const actor of ordered) {
      if (this._fitsTileGrid(state, [...accepted, actor])) {
        accepted.push(actor);
        continue;
      }
      const rec = state.actors.get(actor);
      if (!rec) continue;
      rec.removed = true;
      state.removed.add(rec.id);
      if (actor.get_parent?.() === state.grid) state.grid.remove_child(actor);
      actor.hide();
    }
    this._reorderGrid(state, accepted);
    this._refreshControlGallery(state);
  }

  _setRemovedControls(state, ids) {
    const removed = new Set(ids);
    state.removed = removed;
    for (const [actor, rec] of [...state.actors, ...state.sliders]) {
      actor.remove_all_transitions();
      actor.opacity = 255;
      actor.scale_x = actor.scale_y = 1;
      actor.translation_x = actor.translation_y = 0;
      rec.removing = false;
      const shouldRemove = removed.has(rec.id);
      rec.removed = shouldRemove;
      if (shouldRemove) {
        this._setResizeGripVisible(rec.handle, false);
        this._setResizeGripVisible(rec.removeButton, false);
        if (actor.get_parent?.() === state.grid) state.grid.remove_child(actor);
        actor.hide();
      } else {
        if (actor.get_parent?.() !== state.grid) {
          const parent = actor.get_parent?.();
          if (parent) parent.remove_child(actor);
          state.grid.add_child(actor);
        }
        actor.show();
      }
    }
    this._reorderGrid(state);
    this._refreshControlGallery(state);
  }

  _closeEditor(state) {
    if (state.finishIdle) { GLib.source_remove(state.finishIdle); state.finishIdle = 0; }
    state.exitAction = null;
    this._releaseEditorPointer(state);
    state.editing = false;
    this._cancelGridReflow(state);
    for (const [actor, rec] of [...state.actors, ...state.sliders]) {
      if (rec.removing) {
        rec.removing = false;
        this._setControlRemoved(state, actor, rec, true);
      }
      this._stopAnimation(actor, false);
      actor.remove_all_transitions();
      actor.opacity = 255;
      actor.translation_x = actor.translation_y = 0;
      actor.scale_x = actor.scale_y = 1;
      actor.set_pivot_point(0.5, 0.5);
      for (const button of [rec.handle, rec.removeButton]) {
        if (!button) continue;
        button.translation_x = button.translation_y = 0;
      }
    }
    state.drag = null;
    state.grid.remove_style_class_name("originuicc-editing");
    if (state.confirmPanel) {
      state.confirmPanel.remove_all_transitions();
      try { state.toolbar.remove_child(state.confirmPanel); state.confirmPanel.destroy(); } catch (_) {}
    }
    state.confirmPanel = null;
    state.confirmDialog = null;
    if (state.captureId) { state.grid.disconnect(state.captureId); state.captureId = 0; }
    if (state.dragEventActor) {
      state.dragEventActor.destroy();
      state.dragEventActor = null;
    }
    this._closeControlGallery(state);
    this._closeMaxControlsDialog(state);
    for (const [, rec] of [...state.actors, ...state.sliders]) {
      if (rec.handle) this._setResizeGripVisible(rec.handle, false);
      if (rec.removeButton) this._setResizeGripVisible(rec.removeButton, false);
    }
    state.actions.show();
    state.doneButton.show();
    state.button.show();
    state.toolbar.hide();
    this._syncPanelHeight(state);
  }

  _cleanupEditor(state) {
    this._closeAssistant(state);
    this._closeControlGallery(state);
    if (state.editing) this._closeEditor(state);
    state.destroyed = true;
    state.menu.box.remove_style_class_name("originuicc-control-centre");
    if (state.fitLater) { global.compositor.get_laters().remove(state.fitLater); state.fitLater = 0; }
    for (const [actor, id] of state.viewportSignals ?? []) {
      try { actor.disconnect(id); } catch (_) {}
    }
    if (state.panelViewport) {
      const viewport = state.panelViewport;
      state.panelViewport = null;
      state.menu._boxPointer.bin.set_child(null);
      viewport.set_child(null);
      state.menu._boxPointer.bin.set_child(state.menu.box);
      viewport.destroy();
    }
    if (state.finishIdle) { GLib.source_remove(state.finishIdle); state.finishIdle = 0; }
    this._releaseEditorPointer(state);
    this._cancelGridReflow(state);
    state.grid.layout_manager = state.originalLayout;
    for (const [actor, rec] of [...state.actors, ...state.sliders]) {
      actor.remove_all_transitions();
      actor.scale_x = 1;
      actor.scale_y = 1;
      actor.opacity = 255;
      actor.reactive = true;
      if (actor.get_parent?.() !== state.grid) state.grid.add_child(actor);
      actor.show();
      rec.removed = false;
      if (state.actors.has(actor)) this._setTileSize(state, actor, "2x1");
      if (rec.menuEnabledId) actor.disconnect(rec.menuEnabledId);
      for (const [widget, original] of rec.arrowStates ?? []) {
        if (widget.is_destroyed?.()) continue;
        widget.visible = original.visible;
        widget.reactive = original.reactive;
      }
      for (const [widget, properties] of rec.presentationStates ?? []) {
        if (widget.is_destroyed?.()) continue;
        for (const [key, value] of Object.entries(properties)) widget[key] = value;
      }
      actor.remove_style_class_name("originuicc-tile");
      actor.set_pivot_point(0.5, 0.5);
      actor.translation_x = actor.translation_y = 0;
      if (rec.allocId) { try { actor.disconnect(rec.allocId); } catch (_) {} }
      for (const id of rec.transformIds ?? []) {
        try { actor.disconnect(id); } catch (_) {}
      }
      if (rec.eventId) { try { actor.disconnect(rec.eventId); } catch (_) {} }
      for (const [widget, id] of rec.pressIds ?? []) {
        try { widget.disconnect(id); } catch (_) {}
      }
      if (rec.handle && !rec.handle.is_destroyed?.()) rec.handle.destroy();
      if (rec.removeButton && !rec.removeButton.is_destroyed?.()) rec.removeButton.destroy();
      actor.remove_style_class_name("originuicc-size-1x1"); actor.remove_style_class_name("originuicc-size-2x1"); actor.remove_style_class_name("originuicc-size-2x2");
      actor.remove_style_class_name("originuicc-slider-size-1x2"); actor.remove_style_class_name("originuicc-slider-size-1x4");
      try { state.grid.layout_manager.child_set_property(state.grid, actor, "column-span", rec.originalSpan); } catch (_) {}
    }
    for (const [widget, rec] of state.systemRecords ?? []) {
      widget.remove_style_class_name("originuicc-system-circle");
      for (const [actor, properties] of rec.presentationStates ?? [])
        if (!actor.is_destroyed?.()) for (const [key, value] of Object.entries(properties)) actor[key] = value;
    }
    for (const row of state.fixedActors ?? []) row.remove_style_class_name("originuicc-system-row");
    for (const [actor, span] of state.fixedSpans) {
      try { state.grid.layout_manager.child_set_property(state.grid, actor, "column-span", span); } catch (_) {}
    }
    const originalOrder = [...state.originalPositions].filter(([actor]) => !actor.is_destroyed?.() && actor.get_parent?.() === state.grid).sort((a, b) => a[1] - b[1]).map(([actor]) => actor);
    originalOrder.forEach((actor, index) => { try { state.grid.set_child_at_index(actor, index); } catch (_) {} });
    try { state.button.disconnect(state.clickId); } catch (_) {}
    try { state.addButton.disconnect(state.addId); } catch (_) {}
    try { state.resetButton.disconnect(state.resetId); } catch (_) {}
    try { state.doneButton.disconnect(state.doneId); } catch (_) {}
    try { state.button.destroy(); state.toolbar.destroy(); } catch (_) {}
    try { state.menu.actor.remove_child(state.gripLayer); state.gripLayer.destroy(); } catch (_) {}
    try { state.grid.layout_manager.nColumns = state.originalColumns; } catch (_) {}
  }

  _setupToggleHoverEffects(menu) {
    const grid = menu?._grid;
    if (!grid) return;

    for (const actor of grid.get_children()) {
      const styleClasses = actor?.get_style_class_name?.() ?? "";
      if (
        !/(^|\s)(quick-toggle|quick-menu-toggle|quick-toggle-has-menu|quick-slider)(\s|$)/.test(
          styleClasses,
        ) || this._toggleHoverSignals.has(actor)
      )
        continue;

      actor.set_pivot_point?.(0.5, 0.5);
      const hover = {
        x: 50,
        y: 50,
        alpha: 0,
        lastStyleUpdate: 0,
        fadeSource: 0,
        signals: [],
      };
      const renderGlow = () => {
        const alpha = (hover.alpha * 0.34).toFixed(3);
        actor.set_style(
          `background-image: radial-gradient(ellipse 72% 90% at ${hover.x}% ${hover.y}%, rgba(255, 255, 255, ${alpha}) 0%, rgba(255, 255, 255, ${(hover.alpha * 0.16).toFixed(3)}) 38%, transparent 82%);`,
        );
        hover.lastStyleUpdate = GLib.get_monotonic_time();
      };
      const fadeGlow = (target) => {
        if (hover.fadeSource) GLib.source_remove(hover.fadeSource);
        const startAlpha = hover.alpha;
        const startTime = GLib.get_monotonic_time();
        hover.fadeSource = GLib.timeout_add(
          GLib.PRIORITY_DEFAULT,
          20,
          () => {
            if (actor.is_destroyed?.()) {
              hover.fadeSource = 0;
              return GLib.SOURCE_REMOVE;
            }
            const progress = Math.min(
              (GLib.get_monotonic_time() - startTime) / 260000,
              1,
            );
            const eased = progress * progress * (3 - 2 * progress);
            hover.alpha = startAlpha + (target - startAlpha) * eased;
            renderGlow();
            if (progress < 1) return GLib.SOURCE_CONTINUE;
            hover.fadeSource = 0;
            if (target === 0) actor.set_style(null);
            return GLib.SOURCE_REMOVE;
          },
        );
      };

      let lastX = null;
      let lastY = null;
      const hoverScale = 1.035;
      hover.signals.push(
        actor.connect("enter-event", () => {
          if (this._editorMenus.get(menu)?.editing) return Clutter.EVENT_PROPAGATE;
          lastX = null;
          lastY = null;
          fadeGlow(1);
          actor.ease({
            scale_x: hoverScale,
            scale_y: hoverScale,
            duration: 180,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
          });
          return Clutter.EVENT_PROPAGATE;
        }),
      );
      hover.signals.push(
        actor.connect("motion-event", (_actor, event) => {
          if (this._editorMenus.get(menu)?.editing) return Clutter.EVENT_PROPAGATE;
          const [stageX, stageY] = event.get_coords();
          const [success, localX, localY] = actor.transform_stage_point(
            stageX,
            stageY,
          );
          if (!success || actor.width <= 0 || actor.height <= 0)
            return Clutter.EVENT_PROPAGATE;

          hover.x = Math.clamp((localX / actor.width) * 100, 0, 100).toFixed(1);
          hover.y = Math.clamp((localY / actor.height) * 100, 0, 100).toFixed(1);
          const now = GLib.get_monotonic_time();
          if (!hover.fadeSource && now - hover.lastStyleUpdate >= 50000)
            renderGlow();

          const dragging =
            (event.get_state() & Clutter.ModifierType.BUTTON1_MASK) !== 0;
          if (dragging && lastX !== null && lastY !== null) {
            const dx = localX - lastX;
            const dy = localY - lastY;
            const stretch = Math.min(Math.hypot(dx, dy) / 28, 1) * 0.045;
            if (Math.abs(dx) >= Math.abs(dy)) {
              actor.scale_x = hoverScale + stretch;
              actor.scale_y = hoverScale - stretch * 0.45;
            } else {
              actor.scale_x = hoverScale - stretch * 0.45;
              actor.scale_y = hoverScale + stretch;
            }
          }
          lastX = localX;
          lastY = localY;
          return Clutter.EVENT_PROPAGATE;
        }),
      );
      hover.signals.push(
        actor.connect("button-press-event", (_actor, event) => {
          if (event.get_button() !== 1 || this._editorMenus.get(menu)?.editing) return Clutter.EVENT_PROPAGATE;
          actor.ease({
            scale_x: 0.97,
            scale_y: 0.97,
            duration: 90,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
          });
          return Clutter.EVENT_PROPAGATE;
        }),
      );
      hover.signals.push(
        actor.connect("button-release-event", (_actor, event) => {
          if (event.get_button() !== 1 || this._editorMenus.get(menu)?.editing) return Clutter.EVENT_PROPAGATE;
          actor.ease({
            scale_x: hoverScale,
            scale_y: hoverScale,
            duration: 180,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
          });
          return Clutter.EVENT_PROPAGATE;
        }),
      );
      hover.signals.push(
        actor.connect("leave-event", () => {
          fadeGlow(0);
          if (this._editorMenus.get(menu)?.editing) return Clutter.EVENT_PROPAGATE;
          lastX = null;
          lastY = null;
          actor.ease({
            scale_x: 1,
            scale_y: 1,
            duration: 220,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
          });
          return Clutter.EVENT_PROPAGATE;
        }),
      );
      this._toggleHoverSignals.set(actor, hover);
    }
  }

  _syncAllColorSchemes() {
    for (const menu of this._quickSettingsMenus.keys())
      this._syncColorScheme(menu);
  }

  _syncColorScheme(menu) {
    const schemeClass = this._getColorSchemeClass();
    const actors = [menu?.box, this._editorMenus.get(menu)?.galleryList, ...this._getQuickToggleMenuBoxes(menu)];

    menu?._boxPointer?.add_style_class_name(
      "originuicc-transparent-boxpointer",
    );

    for (const actor of actors) {
      if (!actor) continue;

      actor.remove_style_class_name("originuicc-light");
      actor.remove_style_class_name("originuicc-dark");
      actor.add_style_class_name(schemeClass);
    }
  }

  _clearAllColorSchemes() {
    for (const menu of this._quickSettingsMenus.keys()) {
      menu?._boxPointer?.remove_style_class_name(
        "originuicc-transparent-boxpointer",
      );

      const actors = [menu?.box, this._editorMenus.get(menu)?.galleryList, ...this._getQuickToggleMenuBoxes(menu)];

      for (const actor of actors) {
        if (!actor) continue;

        actor.remove_style_class_name("originuicc-light");
        actor.remove_style_class_name("originuicc-dark");
      }
    }
  }

  _getColorSchemeClass() {
    try {
      const variant = Main.getStyleVariant?.();

      if (variant === "dark") return "originuicc-dark";
      if (variant === "light") return "originuicc-light";
    } catch (_) {}

    return this._colorSettings?.colorScheme === St.SystemColorScheme.PREFER_DARK
      ? "originuicc-dark"
      : "originuicc-light";
  }

  _getQuickSettingsMenus() {
    const menus = new Set();
    const addPanel = (panel) => {
      const menu = panel?.statusArea?.quickSettings?.menu;
      if (menu) menus.add(menu);
    };

    addPanel(Main.panel);

    for (const panelData of global.dashToPanel?.panels ?? [])
      addPanel(panelData?.panel ?? panelData);

    return menus;
  }

  _setupQuickToggleMenuHooks(menu) {
    for (const quickToggleMenu of this._getQuickToggleMenus(menu)) {
      if (this._quickToggleMenuSignals.has(quickToggleMenu)) continue;

      const signalId = quickToggleMenu.connect("open-state-changed", () => {
        this._syncColorScheme(menu);
      });

      this._quickToggleMenuSignals.set(quickToggleMenu, signalId);
    }

    this._syncColorScheme(menu);
  }

  _disconnectQuickToggleMenuHooksForMenu(menu) {
    for (const quickToggleMenu of this._getQuickToggleMenus(menu)) {
      const signalId = this._quickToggleMenuSignals.get(quickToggleMenu);

      if (!signalId) continue;

      try {
        quickToggleMenu.disconnect(signalId);
      } catch (_) {}

      this._quickToggleMenuSignals.delete(quickToggleMenu);
    }
  }

  _getQuickToggleMenus(menu) {
    const grid = menu?._grid;

    if (!grid) return [];

    return grid
      .get_children()
      .map((actor) => actor?.menu)
      .filter((quickToggleMenu) => !!quickToggleMenu?.box);
  }

  _getQuickToggleMenuBoxes(menu) {
    return this._getQuickToggleMenus(menu).map(
      (quickToggleMenu) => quickToggleMenu.box,
    );
  }

  _animateQuickSettingsOpen(menu) {
    const grid = menu?._grid;

    if (!grid?.layout_manager) return;

    const rows = this._getGridRows(grid);
    // Flatten rows to a single list of actors for sequential animation
    const sections = rows.flat();

    sections.forEach((actor, index) => {
      this._animateItemOpen(actor, index * 30);
    });
  }

  _getGridRows(grid) {
    const layout = grid.layout_manager;
    const nColumns = Math.max(1, layout.nColumns ?? layout.n_columns ?? 1);
    const rows = [];
    let currentRow = [];
    let lineIndex = 0;

    const appendRow = () => {
      currentRow = [];
      rows.push(currentRow);
      lineIndex = 0;
    };

    for (const child of grid.get_children()) {
      if (!(child instanceof St.Widget) || !child.visible) continue;

      if (lineIndex === 0) appendRow();

      const colSpan = this._getColumnSpan(layout, grid, child, nColumns);
      const fitsRow = lineIndex + colSpan <= nColumns;

      if (!fitsRow) appendRow();

      currentRow.push(child);
      lineIndex = (lineIndex + colSpan) % nColumns;
    }

    return rows.filter((row) => row.length > 0);
  }

  _getColumnSpan(layout, grid, child, nColumns) {
    let colSpan = 1;

    try {
      const meta = layout.get_child_meta?.(grid, child);
      colSpan = meta?.columnSpan ?? meta?.column_span ?? 1;
    } catch (_) {
      colSpan = 1;
    }

    return Math.clamp(colSpan, 1, nColumns);
  }

  _animateItemOpen(actor, delay = 0, trsY = -35) {
    animateActorOpen(
      actor,
      { translateY: trsY, scaleX: startScale, scaleY: startScale, opacity: 0 },
      { translateY: 0, scaleX: 1, scaleY: 1, opacity: 255 },
      {
        duration: 550,
        delay,
        animationIds: this._animationIds,
        animationTokens: this._animationTokens,
        tokenSymbol: Symbol("datemenu-open-animation"),
        errorTag: "OriginUICC date menu animation failed",
        fill: "both",
      },
    );
  }

  _stopAnimation(actor, restore) {
    stopActorAnimation(
      actor,
      this._animationIds,
      this._animationTokens,
      restore,
    );
  }

  _stopAllAnimations(restore) {
    for (const [actor, frameId] of this._animationIds) {
      GLib.source_remove(frameId);
      if (restore) this._restoreActor(actor);
    }

    this._animationIds.clear();
    this._animationTokens = new WeakMap();
  }

  _restoreActor(actor) {
    restoreActor(actor);
  }
}
