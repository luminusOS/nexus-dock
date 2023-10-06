const { Clutter, GLib, GObject, Meta, Shell, Main, Layout, Dash, AppDisplay } = imports.gi;

const DASH_MAX_HEIGHT_RATIO = 15; // %
const AUTO_HIDE_DELAY = 300; // ms
const SHOWING_ANIMATION_DURATION = 100; // ms
const HIDING_ANIMATION_DURATION = 200; // ms
const SHOW_OVERVIEW_AT_STARTUP = false;

const BottomDock = GObject.registerClass({
    Signals: {'toggle-dash': {}},
}, class BottomDock extends Clutter.Actor {
    _init(layoutMgr, monitor, x, y) {
        super._init();

        this._monitor = monitor;
        this._x = x;
        this._y = y;
        this._fallbackTimeout = FALLBACK_TIMEOUT;
        this._suppressActivationButtonHeld = SUPPRESS_ACTIVATION_WHEN_BUTTON_HELD;
        this._suppressActivationFullscreen = SUPPRESS_ACTIVATION_WHEN_FULLSCREEN;
        this._pressureThreshold = PRESSURE_TRESHOLD;

        this._setupFallbackEdgeIfNeeded(layoutMgr);

        this._pressureBarrier = new Layout.PressureBarrier(this._pressureThreshold,
                                                    HOT_EDGE_PRESSURE_TIMEOUT,
                                                    Shell.ActionMode.NORMAL |
                                                    Shell.ActionMode.OVERVIEW);
        this._pressureBarrier.connect('trigger', this._toggleDock.bind(this));

        this.connect('destroy', this._onDestroy.bind(this));
    }

    setBarrierSize(size) {
        if (this._barrier) {
            this._pressureBarrier.removeBarrier(this._barrier);
            this._barrier.destroy();
            this._barrier = null;
        }

        if (size > 0) {
            size = this._monitor.width;
            let x_offset = (this._monitor.width - size) / 2;
            this._barrier = new Meta.Barrier({display: global.display,
                                                x1: this._x + x_offset, x2: this._x + x_offset + size,
                                                y1: this._y, y2: this._y,
                                                directions: Meta.BarrierDirection.NEGATIVE_Y});
            this._pressureBarrier.addBarrier(this._barrier);
        }
    }

    _setupFallbackEdgeIfNeeded(layoutMgr) {
        if (!global.display.supportsExtendedBarriers()) {
            let size = this._monitor.width;
            let x_offset = this._monitor.width / 2;

            this.set({
                name: 'hot-edge',
                x: this._x + x_offset,
                y: this._y - 1,
                width: size,
                height: 1,
                reactive: true,
                _timeoutId: null
            });
            layoutMgr.addChrome(this);
        }
    }

    _onDestroy() {
        this.setBarrierSize(0);
        this._pressureBarrier.destroy();
        this._pressureBarrier = null;
        GLib.Source.remove(this._timeoutId);
        this._timeoutId = null;
    }

    _toggleDock() {
        if (this._suppressActivationButtonHeld && (global.get_pointer()[2] & Clutter.ModifierType.BUTTON1_MASK)) {
            return;
        }

        if (this._suppressActivationFullscreen && this._monitor.inFullscreen && !Main.overview.visible) {
            return;
        }

        if (Main.overview.shouldToggleByCornerOrButton()) {
            this.emit('toggle-dash');
        }
    }

    vfuncEnterEvent(crossingEvent) {
        if (!this._timeoutId) {
            this._timeoutId = GLib.timeoutAdd(GLib.PRIORITY_HIGH, this._fallbackTimeout, () => {
                this._toggleDock();
                return GLib.SOURCE_REMOVE;
            });
        }
        return Clutter.EVENT_PROPAGATE;
    }

    vfuncLeaveEvent(crossingEvent) {
        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = null;
        }
        return Clutter.EVENT_PROPAGATE;
    }
});

const Dock = GObject.registerClass(class Dock extends Dash.Dash {
    _init() {
        super._init();
        Main.layoutManager.addTopChrome(this);
        this.showAppsButton.setToggleMode(false);
        this._dashContainer.setTrackHover(true);
        this._dashContainer.setReactive(true);
        this.show();
        this._dockAnimated = false;
        this._keepDockShown = false;
    }

    _itemMenuStateChanged(item, opened) {
        if (opened) {
            if (this._showLabelTimeoutId > 0) {
                GLib.sourceRemove(this._showLabelTimeoutId);
                this._showLabelTimeoutId = 0;
            }
            item.hideLabel();

            this._lastAppIconWithMenu = item;
            this._keepDockShown = true;
        } else {
            if (item == this._lastAppIconWithMenu) {
                this._lastAppIconWithMenu = null;
                this._keepDockShown = false
            }
        }

        this._onDockHover();
    }

    _onDockScroll(origin, event) {
        this._activeWorkspace = global.workspace_manager.getActiveWorkspace();
        switch(event.getScrollDirection()) {
            case Clutter.ScrollDirection.DOWN:
            case Clutter.ScrollDirection.RIGHT:
                this._activeWorkspace.getNeighbor(Meta.MotionDirection.RIGHT).activate(event.getTime());
                break;
            case Clutter.ScrollDirection.UP:
            case Clutter.ScrollDirection.LEFT:
                this._activeWorkspace.getNeighbor(Meta.MotionDirection.LEFT).activate(event.getTime());
                break;
        }
    }

    _onDockHover() {
        if (!this._dashContainer.getHover() && !this._keepDockShown) {
            this._autoHideDockTimeout = GLib.timeoutAdd(GLib.PRIORITY_DEFAULT, AUTO_HIDE_DELAY, () => {
                if (!this._dashContainer.getHover()) {
                    this._hideDock();
                    this._autoHideDockTimeout = 0;
                }
            });
        }
    }

    _hideDock() {
        if (this._dockAnimated) {
            return;
        }

        if (!this.workArea) {
            return;
        }

        this._dockAnimated = true;
        this.ease({
            duration: HIDING_ANIMATION_DURATION,
            y: this.workArea.y + this.workArea.height,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this._dockAnimated = false;
                this.hide();
            },
        });
    }

    _showDock() {
        if (this._dockAnimated) {
            return;
        }

        if (!this.workArea) {
            return;
        }

        this.show();
        this._dockAnimated = true;
        this.ease({
            duration: SHOWING_ANIMATION_DURATION,
            y: this.workArea.y + this.workArea.height - this.height,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this._dockAnimated = false;
            },
        });
    }
});

class DockFromDashExtension {
    constructor() {
        this._edgeHandlerId = null;
    }

    _updateHotEdges() {
        for (let i = 0; i < Main.layoutManager.monitors.length; i++) {
            let monitor = Main.layoutManager.monitors[i];
            let leftX = monitor.x;
            let rightX = monitor.x + monitor.width;
            let bottomY = monitor.y + monitor.height;
            let size = monitor.width;

            let haveBottom = true;
            for (let j = 0; j < Main.layoutManager.monitors.length; j++) {
                if (j != i) {
                    let otherMonitor = Main.layoutManager.monitors[j];
                    let otherLeftX = otherMonitor.x;
                    let otherRightX = otherMonitor.x + otherMonitor.width;
                    let otherTopY = otherMonitor.y;
                    if (otherTopY >= bottomY && otherLeftX < rightX && otherRightX > leftX) {
                        haveBottom = false;
                    }
                }
            }

            if (haveBottom) {
                let edge = new BottomDock(Main.layoutManager, monitor, leftX, bottomY);
                edge.connect('toggle-dash', this._toggleDock.bind(this));
                edge.setBarrierSize(size);
                Main.layoutManager.hotCorners.push(edge);
            } else {
                Main.layoutManager.hotCorners.push(null);
            }
        }
    }

    _modifyNativeClickBehavior() {
        this.originalClickFunction = AppDisplay.AppIcon.prototype.activate;
        AppDisplay.AppIcon.prototype.activate = function(button) {
            let event = Clutter.get_current_event();
            let modifiers = event ? event.get_state() : 0;
            let isMiddleButton = button && button == Clutter.BUTTON_MIDDLE;
            let isCtrlPressed = (modifiers & Clutter.ModifierType.CONTROL_MASK) != 0;
            let openNewWindow = this.app.can_open_new_window() && this.app.state == Shell.AppState.RUNNING && (isCtrlPressed || isMiddleButton);
            if (this.app.state == Shell.AppState.STOPPED || openNewWindow) {
                this.animateLaunch();
            }
            if (openNewWindow) {
                this.app.open_new_window(-1);
                Main.overview.hide();
            } else {
                let appWindows = this.app
                    .get_windows()
                    .filter(window => !window.is_override_redirect() && !window.is_attached_dialog())
                    .sort((w1, w2) => w1.get_id() - w2.get_id());

                switch (appWindows.length) {
                    case 0:
                        this.app.activate();
                        Main.overview.hide();
                    break;
                    case 1:
                        if (appWindows[0].has_focus() && appWindows[0].can_minimize()) {
                            appWindows[0].minimize();
                            Main.overview.hide();
                        } else {
                            if (!appWindows[0].has_focus()) {
                                appWindows[0].activate(global.get_current_time());
                                Main.overview.hide();
                            }
                        }
                    break;
                    default:
                        let appHasFocus = false;
                        let appFocusedWindowIndex = 0;
                        for (let index = 0; index < appWindows.length; index++) {
                            if (appWindows[index].has_focus()) {
                                appHasFocus = true;
                                appFocusedWindowIndex = index;
                            }
                        }

                        if (appHasFocus) {
                            let nextIndex = (appFocusedWindowIndex + 1) % appWindows.length;
                            this.app.activate_window(appWindows[nextIndex], global.get_current_time());
                        } else {
                            this.app.activate();
                        }
                }
            }
        }
    }

    _dockRefresh() {
        if (this._dockRefreshing) {
            return;
        }
        this._dockRefreshing = true;

        this._dock.workArea = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
        if (!this._dock.workArea) {
            return;
        }

        this._dock.maxDockHeight = Math.round(this._dock.workArea.height * DASH_MAX_HEIGHT_RATIO / 100);
        this._dock.setWidth(this._dock.workArea.width);
        this._dock.setHeight(Math.min(this._dock.getPreferredHeight(this._dock.workArea.width), this._dock.maxDockHeight));
        this._dock.setMaxSize(this._dock.width, this._dock.maxDockHeight);

        if (this._dock.isVisible()) {
            this._dock.setPosition(this._dock.workArea.x, this._dock.workArea.y + this._dock.workArea.height - this._dock.height);
        } else {
            this._dock.setPosition(this._dock.workArea.x, this._dock.workArea.y + this._dock.workArea.height);
        }

        this._dock.show();
        if (!this._dock._dashContainer.getHover()) {
            this._dock._hideDock();
        }

        this._dockRefreshing = false;
    }

    _toggleDock() {
        if (Main.overview.visible) {
            return;
        }

        if (this._dock.isVisible()) {
            this._dock._hideDock();
        } else {
            this._dock._showDock();
        }
    }

    _onOverviewShown() {
        this._dock.hide();
    }

    _createDock() {
        this._dock = new Dock();

        this._dockRefresh();

        this._dock._dashContainer.connect('notify::hover', this._dock._onDockHover.bind(this._dock));
        this._dock._dashContainer.connect('scroll-event', this._dock._onDockScroll.bind(this._dock));
        this._dock.showAppsButton.connect('button-release-event', () => Main.overview.showApps());

        this._overviewShown = Main.overview.connect('shown', this._onOverviewShown.bind(this));

        this._workareasChanged = global.display.connect_after('workareas-changed', this._dockRefresh.bind(this));
    }

    enable() {
        this._modifyNativeClickBehavior();
        this._createDock();

        this._edgeHandlerId = Main.layoutManager.connect('hot-corners-changed', this._updateHotEdges.bind(this));
        Main.layoutManager._updateHotCorners();

        this.startupComplete = Main.layoutManager.connect('startup-complete', () => {
            if (!SHOW_OVERVIEW_AT_STARTUP) {
                Main.overview.hide();
            }
        });
    }

    disable() {
        AppDisplay.AppIcon.prototype.activate = this.originalClickFunction;

        if (this._overviewShown) {
            Main.overview.disconnect(this._overviewShown);
        }
        if (this._dock._autoHideDockTimeout) {
            GLib.sourceRemove(this._dock._autoHideDockTimeout);
            this._dock._autoHideDockTimeout = 0;
        }
        if (this._workareasChanged) {
            global.display.disconnect(this._workareasChanged);
            this._workareasChanged = null;
        }
        if (this.startupComplete) {
            Main.layoutManager.disconnect(this.startupComplete);
        }

        Main.layoutManager.removeChrome(this._dock);
        this._dock._box.destroy();
        this._dock.destroy();

        Main.layoutManager.disconnect(this._edgeHandlerId);
        Main.layoutManager._updateHotCorners();
    }
}

const dockFromDashExtension = new DockFromDashExtension();
dockFromDashExtension.enable();
