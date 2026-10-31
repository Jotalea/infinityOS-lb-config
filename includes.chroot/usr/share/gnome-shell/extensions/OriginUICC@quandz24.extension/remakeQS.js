import GLib from "gi://GLib";
import Gio from "gi://Gio";
import St from "gi://St";
import Clutter from "gi://Clutter";

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
    if (!/(^|\s)(quick-toggle|quick-menu-toggle|quick-toggle-has-menu)(\s|$)/.test(classes)) return false;
    // Power Mode is a user control. Fixed power/session actions use their
    // system-item class and are kept out of this movable-toggle predicate.
    return !/(battery|screenshot|settings|lock|session)/i.test(this._controlDescription(actor));
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
      state = {menu, grid, button: editButton, toolbar, addButton, resetButton, doneButton, originalColumns, editing: false, actors: new Map(), sliders: new Map(), removed: new Set(this._savedRemoved), fixedSpans: new Map(), fixedRowSpans: new Map(), originalPositions: new Map(), initialOrder: [], saved: null, savedRemoved: [], assistantShown: false, savedApplied: false, signature: "", stablePasses: 0};
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
        try { grid.layout_manager.child_set_property(grid, actor, "row-span", 1); } catch (_) {}
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
    rec.allocId = actor.connect("notify::allocation", () => this._positionResizeGrip(state, actor, rec.handle, rec.removeButton));
    // Drag initiation is handled at stage capture so it works consistently
    // across toggle subclasses and their internal buttons.
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
    this._setTileSize(state, actor, nextSize);
    this._positionResizeGrip(state, actor, rec.handle, rec.removeButton);
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
    if (state.editing) for (const actor of active) {
      const rec = state.actors.get(actor) ?? state.sliders.get(actor);
      if (rec) this._positionResizeGrip(state, actor, rec.handle, rec.removeButton);
    }
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
    if (!state.editing || rec.removed) return;
    actor.remove_all_transitions();
    actor.ease({scale_x: 0.82, scale_y: 0.82, opacity: 0, duration: 170, mode: Clutter.AnimationMode.EASE_IN_QUAD, onComplete: () => {
      if (actor.is_destroyed?.()) return;
      actor.scale_x = 1;
      actor.scale_y = 1;
      actor.opacity = 255;
      this._setControlRemoved(state, actor, rec, true);
      this._reorderGrid(state);
    }});
  }

  _restoreControl(state, actor, rec) {
    if (state.actors.has(actor) && !this._fitsTileGrid(state, null, actor, "2x1")) {
      this._showMaxControlsDialog(state);
      return false;
    }
    const parent = actor.get_parent?.();
    if (parent && parent !== state.grid) parent.remove_child(actor);
    actor.remove_all_transitions();
    actor.reactive = true;
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
    actor.ease({scale_x: 1, scale_y: 1, opacity: 255, duration: 190, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
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
    const list = new St.BoxLayout({vertical: true, style_class: "originuicc-gallery-list"});
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
    const panelWidth = Math.min(620, global.stage.width - 48);
    const panelHeight = Math.min(520, global.stage.height - 64);
    const panelX = (global.stage.width - panelWidth) / 2;
    const panelY = (global.stage.height - panelHeight) / 2;
    const [menuX, menuY] = state.menu.actor.get_transformed_position();
    panel.set_size(panelWidth, panelHeight);
    scroll.set_size(panelWidth - 48, panelHeight - 150);
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
      for (let index = 0; index < removed.length; index += 2) {
        const row = new St.BoxLayout({style_class: "originuicc-gallery-row"});
        row.x_expand = true;
        for (const [actor, rec] of removed.slice(index, index + 2)) {
          const tile = new St.BoxLayout({vertical: true, style_class: "originuicc-gallery-tile"});
          tile.x_expand = true;
          const iconName = actor?._icon?.icon_name ?? actor?._box?.get_first_child?.()?.icon_name ?? actor?.icon_name ?? "preferences-system-symbolic";
          tile.add_child(new St.Icon({icon_name: iconName, icon_size: 20, x_align: Clutter.ActorAlign.CENTER}));
          tile.add_child(new St.Label({text: this._controlLabel(actor, rec), x_expand: true, x_align: Clutter.ActorAlign.CENTER}));
          const add = new St.Button({child: new St.Icon({icon_name: "list-add-symbolic", icon_size: 18}), style_class: "originuicc-gallery-add", can_focus: true});
          tile.add_child(add);
          row.add_child(tile);
          add.connect("clicked", () => this._restoreControl(state, actor, rec));
        }
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
  }

  _positionResizeGrip(state, actor, grip, removeButton = null) {
    if (!actor || actor.is_destroyed?.() || (!grip && !removeButton)) return;
    const [x, y] = actor.get_transformed_position();
    const [width, height] = actor.get_transformed_size();
    if (grip && !grip.is_destroyed?.()) {
      const [ok, localX, localY] = state.gripLayer.transform_stage_point(x + width - 23, y + height - 23);
      if (ok) grip.set_position(localX, localY);
      try { state.gripLayer.set_child_above_sibling(grip, null); } catch (_) {}
    }
    if (removeButton) {
      const [removeOk, removeX, removeY] = state.gripLayer.transform_stage_point(x - 1, y - 1);
      if (removeOk) removeButton.set_position(removeX, removeY);
      try { state.gripLayer.set_child_above_sibling(removeButton, null); } catch (_) {}
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

  _serializeLayout(state) {
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
    const cells = Array.from({length: 12}, () => Array(4).fill(false));
    const actors = order ?? state.grid.get_children().filter(actor => state.actors.has(actor) && !state.actors.get(actor)?.removed);
    const entries = [...actors];
    if (extraActor && !entries.includes(extraActor)) entries.push(extraActor);
    for (const actor of entries) {
      const rec = state.actors.get(actor);
      if (!rec || (rec.removed && actor !== extraActor)) continue;
      const size = actor === extraActor && extraSize ? extraSize : rec.size;
      const [width, height] = this._tileDimensions(size);
      let placed = false;
      for (let row = 0; row <= 12 - height && !placed; row++) {
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
    panel.add_child(new St.Label({text: "Maximum number of toggles reached", style_class: "originuicc-limit-title"}));
    panel.add_child(new St.Label({text: "Remove a toggle or choose a smaller size to make room.", style_class: "originuicc-limit-message"}));
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
    const width = Math.min(420, global.stage.width - 48);
    const height = 220;
    const [menuX, menuY] = state.menu.actor.get_transformed_position();
    panel.set_size(width, height);
    panel.set_position((global.stage.width - width) / 2 - menuX, (global.stage.height - height) / 2 - menuY);
    panel.opacity = 0;
    panel.translation_y = 20;
    state.menu.actor.set_child_above_sibling(host, null);
    panel.ease({opacity: 255, translation_y: 0, duration: 180, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    okay.connect("clicked", () => this._closeMaxControlsDialog(state));
  }

  _closeMaxControlsDialog(state) {
    const host = state.limitHost;
    state.limitHost = null;
    state.limitPanel = null;
    state.limitDialog = false;
    if (!host) return;
    try { state.menu.actor.remove_child(host); host.destroy(); } catch (_) {}
  }

  _setCompactArrowVisibility(actor, rec, visible) {
    if (!rec || !actor) return;
    rec.arrowStates ??= new Map();
    const targets = new Set();
    const visit = widget => {
      const classes = widget?.get_style_class_name?.() ?? "";
      if (/(^|\s)(quick-toggle-arrow-button|quick-toggle-menu-button|quick-toggle-arrow)(\s|$)/.test(classes)) {
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
      target.visible = visible ? original.visible : false;
      target.reactive = visible ? original.reactive : false;
    }
  }

  _setTileSize(state, actor, size) {
    size = this._normalizeTileSize(size);
    const [colsRequested, rowsRequested] = this._tileDimensions(size);
    const columns = Math.max(1, state.grid.layout_manager.nColumns ?? state.grid.layout_manager.n_columns ?? 4);
    const cols = Math.min(colsRequested, columns);
    const rows = Math.min(rowsRequested, 12);
    const rec = state.actors.get(actor);
    if (rec) rec.size = size;
    actor.remove_style_class_name("originuicc-size-1x1");
    actor.remove_style_class_name("originuicc-size-2x1");
    actor.remove_style_class_name("originuicc-size-2x2");
    actor.add_style_class_name(`originuicc-size-${size}`);
    if (actor.get_parent?.() === state.grid) {
      try { state.grid.layout_manager.child_set_property(state.grid, actor, "column-span", cols); } catch (_) {}
      try { state.grid.layout_manager.child_set_property(state.grid, actor, "row-span", rows); } catch (_) {}
    }
    const compact = size === "1x1";
    const large = size === "2x2";
    this._setCompactArrowVisibility(actor, rec, !compact);

    const contentBox = actor?._box;
    if (contentBox) {
      rec.contentBoxState ??= {vertical: contentBox.vertical, xExpand: contentBox.x_expand, xAlign: contentBox.x_align};
      contentBox.vertical = false;
      contentBox.x_expand = true;
      contentBox.x_align = Clutter.ActorAlign.FILL;
    }
    let mainIcon = actor?._icon ?? null;
    const findMainIcon = widget => {
      if (!widget || mainIcon) return;
      if (widget instanceof St.Icon && !/(^|\s)quick-toggle-arrow(\s|$)/.test(widget.get_style_class_name?.() ?? "")) {
        mainIcon = widget;
        return;
      }
      for (const child of widget.get_children?.() ?? []) findMainIcon(child);
    };
    if (!mainIcon) findMainIcon(actor?._box ?? actor);
    if (mainIcon) {
      rec.iconSizes ??= new Map();
      if (!rec.iconSizes.has(mainIcon)) rec.iconSizes.set(mainIcon, {size: mainIcon.icon_size, xAlign: mainIcon.x_align, yAlign: mainIcon.y_align});
      mainIcon.icon_size = 18;
      mainIcon.x_align = compact ? Clutter.ActorAlign.CENTER : Clutter.ActorAlign.START;
      mainIcon.y_align = Clutter.ActorAlign.CENTER;
    }

    const titleBox = actor?._box?.get_children?.()[1];
    if (titleBox) {
      rec.titleBoxState ??= {visible: titleBox.visible, xAlign: titleBox.x_align, yAlign: titleBox.y_align, xExpand: titleBox.x_expand};
      titleBox.visible = compact ? false : rec.titleBoxState.visible;
      titleBox.x_align = compact ? Clutter.ActorAlign.CENTER : (large ? Clutter.ActorAlign.END : Clutter.ActorAlign.START);
      titleBox.y_align = large ? Clutter.ActorAlign.END : Clutter.ActorAlign.CENTER;
      titleBox.x_expand = large;
    }
    const setLabelVisibility = widget => {
      if (widget instanceof St.Label) {
        rec.labelStates ??= new Map();
        if (!rec.labelStates.has(widget)) rec.labelStates.set(widget, {visible: widget.visible, xAlign: widget.x_align});
        const original = rec.labelStates.get(widget);
        widget.visible = compact ? false : original.visible;
        widget.x_align = large ? Clutter.ActorAlign.END : Clutter.ActorAlign.START;
      }
      for (const child of widget?.get_children?.() ?? []) setLabelVisibility(child);
    };
    setLabelVisibility(actor);
    if (rec?.handle) this._setResizeGripVisible(rec.handle, state.editing && !rec.removed);
    if (rec?.removeButton) this._setResizeGripVisible(rec.removeButton, state.editing && !rec.removed);
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
      try { state.grid.layout_manager.child_set_property(state.grid, actor, "row-span", 1); } catch (_) {}
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
      this._positionResizeGrip(state, actor, rec.handle, rec.removeButton);
      if (rec.handle) this._setResizeGripVisible(rec.handle, true);
      this._setResizeGripVisible(rec.removeButton, true);
    }
    try { state.menu.actor.set_child_above_sibling(state.gripLayer, null); } catch (_) {}
    state.stageId = global.stage.connect("captured-event", (_stage, event) => this._editorDragEvent(state, event));
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

  _animateGridReorder(state, preferredOrder, drag = null) {
    if (!this._fitsTileGrid(state, preferredOrder)) {
      this._showMaxControlsDialog(state);
      return false;
    }
    const before = new Map();
    for (const [actor, rec] of [...state.actors, ...state.sliders]) {
      if (rec.removed || actor.get_parent?.() !== state.grid) continue;
      if (actor !== drag?.actor) {
        const [x, y] = actor.get_transformed_position();
        before.set(actor, {x, y});
      }
      actor.remove_all_transitions();
      actor.translation_x = 0;
      actor.translation_y = 0;
      for (const button of [rec.handle, rec.removeButton]) {
        if (!button || button.is_destroyed?.()) continue;
        button.remove_all_transitions();
        button.translation_x = 0;
        button.translation_y = 0;
      }
    }
    this._reorderGrid(state, preferredOrder);
    const serial = state.reorderSerial = (state.reorderSerial ?? 0) + 1;
    if (drag) drag.reorderPending = true;
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
      if (serial !== state.reorderSerial || !state.editing) return GLib.SOURCE_REMOVE;
      if (drag) drag.reorderPending = false;
      for (const [actor, old] of before) {
        if (actor.is_destroyed?.() || actor.get_parent?.() !== state.grid) continue;
        const [x, y] = actor.get_transformed_position();
        const dx = old.x - x;
        const dy = old.y - y;
        const rec = state.actors.get(actor) ?? state.sliders.get(actor);
        this._positionResizeGrip(state, actor, rec?.handle, rec?.removeButton);
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
        actor.translation_x = dx;
        actor.translation_y = dy;
        actor.ease({translation_x: 0, translation_y: 0, duration: 200, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        for (const button of [rec?.handle, rec?.removeButton]) {
          if (!button || button.is_destroyed?.() || !button.visible) continue;
          button.translation_x = dx;
          button.translation_y = dy;
          button.ease({translation_x: 0, translation_y: 0, duration: 200, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
      }
      if (drag?.actor && drag.actor.get_parent?.() === state.grid) {
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
    actor.remove_all_transitions();
    actor.translation_x = 0;
    actor.translation_y = 0;
    const [baseX, baseY] = actor.get_transformed_position();
    actor.translation_x = stageX - drag.offsetX - baseX;
    actor.translation_y = stageY - drag.offsetY - baseY;
    const rec = drag.rec;
    this._positionResizeGrip(state, actor, rec?.handle, rec?.removeButton);
  }

  _findDragTarget(state, drag, stageX, stageY) {
    const candidates = [...state.actors.keys(), ...state.sliders.keys()].filter(actor =>
      actor !== drag.actor && !state.actors.get(actor)?.removed && !state.sliders.get(actor)?.removed && actor.get_parent?.() === state.grid);
    const hit = candidates.find(actor => this._pointInside(actor, stageX, stageY));
    if (hit) return hit;
    return candidates.reduce((nearest, actor) => {
      const [x, y] = actor.get_transformed_position();
      const [width, height] = actor.get_transformed_size();
      const distance = Math.hypot(stageX - (x + width / 2), stageY - (y + height / 2));
      return !nearest || distance < nearest.distance ? {actor, distance} : nearest;
    }, null)?.actor ?? null;
  }

  _reorderDraggedActor(state, drag, stageX, stageY) {
    const target = this._findDragTarget(state, drag, stageX, stageY);
    if (!target || target === drag.hoverTarget) return;
    const order = state.grid.get_children().filter(actor => {
      const rec = state.actors.get(actor) ?? state.sliders.get(actor);
      return rec && !rec.removed;
    });
    const from = order.indexOf(drag.actor);
    const targetIndex = order.indexOf(target);
    if (from < 0 || targetIndex < 0) return;
    const [x, y] = target.get_transformed_position();
    const [width, height] = target.get_transformed_size();
    const after = Math.abs(stageX - (x + width / 2)) > Math.abs(stageY - (y + height / 2))
      ? stageX > x + width / 2
      : stageY > y + height / 2;
    order.splice(from, 1);
    let insertAt = targetIndex + (after ? 1 : 0) - (from < targetIndex ? 1 : 0);
    insertAt = Math.max(0, Math.min(order.length, insertAt));
    order.splice(insertAt, 0, drag.actor);
    const currentOrder = state.grid.get_children().filter(child => {
      const rec = state.actors.get(child) ?? state.sliders.get(child);
      return rec && !rec.removed;
    });
    if (order.every((actor, index) => actor === currentOrder[index])) return;
    if (this._animateGridReorder(state, order, drag)) drag.hoverTarget = target;
  }

  _settleDraggedActor(state, drag) {
    const actor = drag.actor;
    if (!actor || actor.is_destroyed?.() || actor.get_parent?.() !== state.grid) return;
    const dx = actor.translation_x;
    const dy = actor.translation_y;
    actor.remove_all_transitions();
    actor.translation_x = 0;
    actor.translation_y = 0;
    this._positionResizeGrip(state, actor, drag.rec?.handle, drag.rec?.removeButton);
    for (const button of [drag.rec?.handle, drag.rec?.removeButton]) {
      if (!button || button.is_destroyed?.() || !button.visible) continue;
      button.remove_all_transitions();
      button.translation_x = dx;
      button.translation_y = dy;
      button.ease({translation_x: 0, translation_y: 0, duration: 160, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }
    actor.translation_x = dx;
    actor.translation_y = dy;
    actor.ease({translation_x: 0, translation_y: 0, duration: 160, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
  }

  _editorDragEvent(state, event) {
    if (!state.editing || state.galleryDialog || state.confirmDialog || state.limitDialog)
      return Clutter.EVENT_PROPAGATE;
    const type = event.type();
    const [sx, sy] = event.get_coords?.() ?? [0, 0];
    if (type === Clutter.EventType.BUTTON_PRESS && !state.drag) {
      const controls = [...state.actors, ...state.sliders];
      for (const [candidate, rec] of controls) {
        if (rec.removed || candidate.get_parent?.() !== state.grid || !this._pointInside(candidate, sx, sy)) continue;
        // Keep resize/remove buttons clickable instead of starting a tile drag.
        if (this._pointInside(rec.handle, sx, sy) || this._pointInside(rec.removeButton, sx, sy))
          return Clutter.EVENT_PROPAGATE;
        const [actorX, actorY] = candidate.get_transformed_position();
        state.drag = {actor: candidate, rec, sx, sy, moved: false, offsetX: sx - actorX, offsetY: sy - actorY, currentX: sx, currentY: sy, hoverTarget: null, reorderPending: false, released: false};
        return Clutter.EVENT_PROPAGATE;
      }
      return Clutter.EVENT_PROPAGATE;
    }
    if (!state.drag) return Clutter.EVENT_PROPAGATE;
    const drag = state.drag;
    const {actor} = drag;
    if (type === Clutter.EventType.MOTION) {
      const dx = sx - drag.sx, dy = sy - drag.sy;
      if (Math.hypot(dx, dy) > 10) {
        drag.moved = true;
        drag.currentX = sx;
        drag.currentY = sy;
        this._positionDraggedActor(state, drag, sx, sy);
        this._reorderDraggedActor(state, drag, sx, sy);
        return Clutter.EVENT_STOP;
      }
      return Clutter.EVENT_PROPAGATE;
    }
    if (type !== Clutter.EventType.BUTTON_RELEASE)
      return Clutter.EVENT_PROPAGATE;
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
      return Clutter.EVENT_PROPAGATE;
    }
    return Clutter.EVENT_STOP;
  }

  _finishEdit(state) {
    if (state.confirmPanel) return;
    const panel = new St.BoxLayout({style_class: "originuicc-editor-confirm"});
    panel.add_child(new St.Label({text: "Save your changes?", x_expand: true}));
    const discard = new St.Button({label: "Discard", style_class: "originuicc-confirm-discard"});
    const save = new St.Button({label: "Save", style_class: "originuicc-confirm-save"});
    panel.add_child(discard);
    panel.add_child(save);
    state.toolbar.add_child(panel);
    state.confirmPanel = panel;
    state.confirmDialog = true;
    discard.connect("clicked", () => {
      this._applySerializedLayout(state, state.saved ?? []);
      this._setRemovedControls(state, state.savedRemoved ?? []);
      state.confirmDialog = null;
      GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        this._closeEditor(state);
        return GLib.SOURCE_REMOVE;
      });
    });
    save.connect("clicked", () => {
      this._savedLayout = this._serializeLayout(state);
      this._savedRemoved = [...state.removed];
      this._writeLayout(this._savedLayout, this._savedRemoved);
      state.savedApplied = true;
      state.confirmDialog = null;
      GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        this._closeEditor(state);
        return GLib.SOURCE_REMOVE;
      });
    });
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
    state.editing = false;
    state.drag = null;
    state.grid.remove_style_class_name("originuicc-editing");
    if (state.confirmPanel) {
      try { state.toolbar.remove_child(state.confirmPanel); state.confirmPanel.destroy(); } catch (_) {}
    }
    state.confirmPanel = null;
    state.confirmDialog = null;
    if (state.stageId) { global.stage.disconnect(state.stageId); state.stageId = 0; }
    this._closeControlGallery(state);
    this._closeMaxControlsDialog(state);
    for (const [, rec] of [...state.actors, ...state.sliders]) {
      if (rec.handle) this._setResizeGripVisible(rec.handle, false);
      if (rec.removeButton) this._setResizeGripVisible(rec.removeButton, false);
    }
    state.button.show();
    state.toolbar.hide();
  }

  _cleanupEditor(state) {
    this._closeAssistant(state);
    this._closeControlGallery(state);
    if (state.editing) this._closeEditor(state);
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
      for (const [icon, original] of rec.iconSizes ?? []) {
        if (icon.is_destroyed?.()) continue;
        icon.icon_size = original.size;
        icon.x_align = original.xAlign;
        icon.y_align = original.yAlign;
      }
      if (actor._box && rec.contentBoxState) {
        actor._box.vertical = rec.contentBoxState.vertical;
        actor._box.x_expand = rec.contentBoxState.xExpand;
        actor._box.x_align = rec.contentBoxState.xAlign;
      }
      const titleBox = actor._box?.get_children?.()[1];
      if (titleBox && rec.titleBoxState) {
        titleBox.visible = rec.titleBoxState.visible;
        titleBox.x_align = rec.titleBoxState.xAlign;
        titleBox.y_align = rec.titleBoxState.yAlign;
        titleBox.x_expand = rec.titleBoxState.xExpand;
      }
      for (const [label, original] of rec.labelStates ?? []) {
        if (label.is_destroyed?.()) continue;
        label.visible = original.visible;
        label.x_align = original.xAlign;
      }
      if (rec.allocId) { try { actor.disconnect(rec.allocId); } catch (_) {} }
      if (rec.eventId) { try { actor.disconnect(rec.eventId); } catch (_) {} }
      if (rec.handle && !rec.handle.is_destroyed?.()) rec.handle.destroy();
      if (rec.removeButton && !rec.removeButton.is_destroyed?.()) rec.removeButton.destroy();
      actor.remove_style_class_name("originuicc-size-1x1"); actor.remove_style_class_name("originuicc-size-2x1"); actor.remove_style_class_name("originuicc-size-2x2");
      actor.remove_style_class_name("originuicc-slider-size-1x2"); actor.remove_style_class_name("originuicc-slider-size-1x4");
      try { state.grid.layout_manager.child_set_property(state.grid, actor, "column-span", rec.originalSpan); } catch (_) {}
      try { state.grid.layout_manager.child_set_property(state.grid, actor, "row-span", rec.originalRowSpan); } catch (_) {}
    }
    for (const [actor, span] of state.fixedSpans) {
      try { state.grid.layout_manager.child_set_property(state.grid, actor, "column-span", span); } catch (_) {}
      try { state.grid.layout_manager.child_set_property(state.grid, actor, "row-span", state.fixedRowSpans.get(actor) ?? 1); } catch (_) {}
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
          if (event.get_button() !== 1) return Clutter.EVENT_PROPAGATE;
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
          if (event.get_button() !== 1) return Clutter.EVENT_PROPAGATE;
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
    const actors = [menu?.box, ...this._getQuickToggleMenuBoxes(menu)];

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

      const actors = [menu?.box, ...this._getQuickToggleMenuBoxes(menu)];

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
