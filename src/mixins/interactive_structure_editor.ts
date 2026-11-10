import * as THREE from "three";
import { TransformControls } from "three/examples/jsm/controls/TransformControls";

import { DRAG_THRESHOLD_PX } from "./interactive_editor_constants";

type Coordinate3D = [number, number, number];

const HOVER_HIGHLIGHT_COLOR = 0x54aeff;
const SELECTION_HIGHLIGHT_COLOR = 0x0969da;
const HIGHLIGHT_SCALE_FACTOR = 1.25;
const DRAG_COMMIT_EPSILON = 1e-6;

/**
 * Value put in OrbitControls' `touches.ONE` while edit mode owns the first finger (U-13).
 *
 * OrbitControls has no "no gesture" constant for touch the way `mouseButtons` accepts null: its
 * `onTouchStart` switches on `touches.ONE` over TOUCH.ROTATE and TOUCH.PAN and falls through to
 * `STATE.NONE` for anything else. Deliberately outside the enum (TOUCH runs 0-3), and named so the
 * next reader does not "fix" it into a real gesture.
 */
const ONE_FINGER_RESERVED_FOR_EDITING = -1;

/**
 * Mixin providing interactive structure editing capabilities inside the Wave visualizer.
 * Enforces strict object-oriented design and follows the "6 months x 3 beers" rule for comments.
 */
export const InteractiveStructureEditorMixin = (superclass: any) =>
    class extends superclass {
        transformControls_: TransformControls | null;

        transformDragStartPosition_: THREE.Vector3 | null;

        transformDragStartQuaternion_: THREE.Quaternion | null;

        raycaster_: THREE.Raycaster | null;

        pointer_: THREE.Vector2 | null;

        selectedMesh_: THREE.Mesh | null;

        selectedMeshes_: THREE.Mesh[];

        hoveredMesh_: THREE.Mesh | null;

        selectionHighlightPool_: THREE.Mesh[];

        hoverHighlightMesh_: THREE.Mesh | null;

        isEditModeEnabled_: boolean;

        pointerDownPosition_: { x: number; y: number } | null;

        pendingDragAtom_: THREE.Mesh | null;

        isDraggingAtom_: boolean;

        dragPlane_: THREE.Plane | null;

        dragOffset_: THREE.Vector3 | null;

        dragStartPosition_: THREE.Vector3 | null;

        activePointerId_: number | null;

        orbitControlsEnabledBeforeDrag_: boolean;

        orbitControlsDefaultMouseButtons_: any | null;

        orbitControlsDefaultTouches_: any | null;

        lastSelectedAtomicIndices_: number[] | null;

        handlePointerDownCapture_: ((event: PointerEvent) => void) | null;

        handlePointerMoveCapture_: ((event: PointerEvent) => void) | null;

        handlePointerUpCapture_: ((event: PointerEvent) => void) | null;

        handlePointerCancelCapture_: ((event: PointerEvent) => void) | null;

        handleEditModeKeyDown_: ((event: KeyboardEvent) => void) | null;

        constructor(config: any) {
            super(config);

            this.transformControls_ = null;
            this.transformDragStartPosition_ = null;
            this.transformDragStartQuaternion_ = null;
            this.raycaster_ = null;
            this.pointer_ = null;
            this.selectedMesh_ = null;
            this.selectedMeshes_ = [];
            this.hoveredMesh_ = null;
            this.selectionHighlightPool_ = [];
            this.hoverHighlightMesh_ = null;
            this.isEditModeEnabled_ = false;
            this.pointerDownPosition_ = null;
            this.pendingDragAtom_ = null;
            this.isDraggingAtom_ = false;
            this.dragPlane_ = null;
            this.dragOffset_ = null;
            this.dragStartPosition_ = null;
            this.activePointerId_ = null;
            this.orbitControlsEnabledBeforeDrag_ = true;
            this.orbitControlsDefaultMouseButtons_ = null;
            this.orbitControlsDefaultTouches_ = null;
            this.lastSelectedAtomicIndices_ = null;
            this.handlePointerDownCapture_ = null;
            this.handlePointerMoveCapture_ = null;
            this.handlePointerUpCapture_ = null;
            this.handlePointerCancelCapture_ = null;
            this.handleEditModeKeyDown_ = null;

            this.initializeEditor = this.initializeEditor.bind(this);
            this.initializeSelectionRaycaster = this.initializeSelectionRaycaster.bind(this);
            this.handlePointerDown = this.handlePointerDown.bind(this);
            this.setTransformMode = this.setTransformMode.bind(this);
            this.addAtom = this.addAtom.bind(this);
            this.removeSelectedAtom = this.removeSelectedAtom.bind(this);
            this.cloneSelectedAtoms = this.cloneSelectedAtoms.bind(this);
            this.focusCameraOnSelection = this.focusCameraOnSelection.bind(this);
            this.enableEditMode = this.enableEditMode.bind(this);
            this.disableEditMode = this.disableEditMode.bind(this);
            this.toggleOrthographicCamera = this.toggleOrthographicCamera.bind(this);

            // Setup editor components after parent class setup is complete
            this.initializeEditor();
            this.initializeSelectionRaycaster();
        }

        /**
         * Initializes the Three.js TransformControls, adds them to the scene, and binds drag lifecycle listeners.
         * Dragging updates temporary camera locks to avoid rotation conflicts.
         */
        initializeEditor(): void {
            this.transformControls_ = new TransformControls(this.camera, this.renderer.domElement);
            this.scene.add(this.transformControls_);

            this.selectionPivot_ = new THREE.Object3D();
            this.scene.add(this.selectionPivot_);

            this.hoverHighlightMesh_ = this.createHighlightMesh_(HOVER_HIGHLIGHT_COLOR, 0.5);
            this.scene.add(this.hoverHighlightMesh_);

            // Rerender the viewport on every translation/rotation frame update; while dragging the
            // group pivot, handleGroupPivotChange_ (GroupTransformMixin) also propagates its live
            // delta to every selected atom so they move rigidly together during the gizmo drag,
            // not just once on commit (decision D-4's "group rotate" half).
            this.transformControls_.addEventListener("change", () => {
                this.handleGroupPivotChange_();
                this.render();
            });

            // Disables the OrbitControls while dragging an atom to avoid camera movement conflicts
            this.transformControls_.addEventListener("dragging-changed", (event: any) => {
                if (event.value) {
                    this.orbitControlsEnabledBeforeDrag_ = this.orbitControls?.enabled ?? true;
                    if (this.orbitControls) this.orbitControls.enabled = false;
                    // Snapshot the object's position when a drag starts so mouseUp can tell
                    // whether the gizmo actually moved anything (a zero-movement click-release
                    // must not commit), and Esc can revert to it.
                    this.transformDragStartPosition_ =
                        this.transformControls_?.object?.position.clone() ?? null;
                    this.transformDragStartQuaternion_ =
                        this.transformControls_?.object?.quaternion.clone() ?? null;
                    if (this.transformControls_?.object === this.selectionPivot_) {
                        this.captureGroupDragStartPositions_();
                    }
                } else {
                    if (this.orbitControls) {
                        this.orbitControls.enabled = this.orbitControlsEnabledBeforeDrag_;
                    }
                    this.transformDragStartPosition_ = null;
                    this.transformDragStartQuaternion_ = null;
                }
            });

            // Rerender scene and trigger callbacks when the drag operation completes
            this.transformControls_.addEventListener("mouseUp", () => {
                const draggedObject = this.transformControls_?.object;
                const startPosition = this.transformDragStartPosition_;
                const startQuaternion = this.transformDragStartQuaternion_;
                const wasRotate = this.transformControls_?.mode === "rotate";
                const hasMoved =
                    !!draggedObject &&
                    !!startPosition &&
                    draggedObject.position.distanceTo(startPosition) > DRAG_COMMIT_EPSILON;
                // A pure rotation about the pivot's own (fixed) position never changes
                // draggedObject.position, so a rotate-mode commit must be detected via the
                // quaternion instead - hasMoved alone would never fire for it.
                const hasRotated =
                    !!draggedObject &&
                    !!startQuaternion &&
                    draggedObject.quaternion.angleTo(startQuaternion) > DRAG_COMMIT_EPSILON;

                if ((hasMoved || hasRotated) && draggedObject) {
                    if (draggedObject === this.selectionPivot_) {
                        this.commitGroupGizmoDrag_(wasRotate);
                    } else {
                        this.commitMovedAtom_(
                            draggedObject.userData.atomicIndex,
                            draggedObject.position,
                            "gizmo",
                        );
                    }
                }
                this.groupDragStartPositions_ = null;
            });
        }

        /**
         * Creates a camera-agnostic highlight halo: a slightly larger wireframe sphere layered
         * around an atom. Kept as a dedicated object with its own material rather than mutating
         * the atom mesh's own material.emissive, which spin-glow and measurement-hover already
         * write to - sharing that channel means selecting/deselecting an atom would erase
         * whichever of those effects got there first.
         */
        createHighlightMesh_(color: number, opacity: number): THREE.Mesh {
            const geometry = new THREE.SphereGeometry(1, 16, 16);
            const material = new THREE.MeshBasicMaterial({
                color,
                transparent: true,
                opacity,
                wireframe: true,
                depthWrite: false,
            });
            const mesh = new THREE.Mesh(geometry, material);
            mesh.visible = false;
            // Never itself a raycast/pick target.
            // eslint-disable-next-line @typescript-eslint/no-empty-function
            mesh.raycast = () => {};
            return mesh;
        }

        /**
         * Positions and shows/hides a halo mesh around the given atom (or hides it if null).
         */
        updateHighlightMesh_(haloMesh: THREE.Mesh | null, atomMesh: THREE.Mesh | null): void {
            if (!haloMesh) return;
            if (!atomMesh) {
                haloMesh.visible = false;
                return;
            }
            haloMesh.position.copy(atomMesh.position);
            const radius = atomMesh.scale.x * HIGHLIGHT_SCALE_FACTOR;
            haloMesh.scale.set(radius, radius, radius);
            haloMesh.visible = true;
        }

        /**
         * Keeps exactly one visible halo per selected atom, reusing a pool rather than
         * creating/disposing geometry on every selection change or drag-frame update.
         */
        syncHighlightPoolTo_(meshes: THREE.Mesh[]): void {
            while (this.selectionHighlightPool_.length < meshes.length) {
                const halo = this.createHighlightMesh_(SELECTION_HIGHLIGHT_COLOR, 0.9);
                this.scene.add(halo);
                this.selectionHighlightPool_.push(halo);
            }
            this.selectionHighlightPool_.forEach((halo: THREE.Mesh, index: number) => {
                this.updateHighlightMesh_(halo, meshes[index] ?? null);
            });
        }

        /**
         * Initializes the pointer vector and Raycaster used both for click-to-select and for
         * direct click-and-drag: pressing down on an atom and moving the pointer drags that atom
         * in the camera-facing plane immediately, without needing to separately grab a gizmo
         * handle first. A plain click (press+release with negligible movement) still only
         * selects, via handlePointerDown() below, matching the original click-to-select behavior;
         * the gizmo remains available afterwards for precise axis-constrained edits.
         *
         * Pressing down on empty space starts a marquee-select instead (see
         * updateMarqueeState_/finishMarqueeSelection_): orbiting the camera moves to a
         * right-mouse-drag while in edit mode (see enableEditMode) so the two gestures don't
         * collide on the same button (decision D-4).
         */
        initializeSelectionRaycaster(): void {
            this.raycaster_ = new THREE.Raycaster();
            this.pointer_ = new THREE.Vector2();

            this.handlePointerDownCapture_ = (event: PointerEvent) => {
                // Only the primary (left) button starts a selection, drag, or marquee; a
                // PointerEvent constructed without an explicit button (as synthetic test events
                // often are) defaults to 0 per spec, so only reject an EXPLICIT non-zero button.
                if (event.button !== undefined && event.button !== 0) return;

                this.pointerDownPosition_ = { x: event.clientX, y: event.clientY };
                this.pendingDragAtom_ = null;
                this.isDraggingAtom_ = false;
                this.activePointerId_ = event.pointerId ?? null;

                if (!this.isEditModeEnabled_) return;
                // Let TransformControls handle its own gizmo-handle drags exclusively
                if (this.transformControls_ && this.transformControls_.dragging) return;

                this.pendingDragAtom_ = this.getAtomAtPointer(event);
                if (!this.pendingDragAtom_) {
                    this.marqueeStartScreen_ = { x: event.clientX, y: event.clientY };
                    this.marqueeModifierAdd_ = event.shiftKey;
                    this.marqueeModifierToggle_ = event.ctrlKey || event.metaKey;
                }
            };

            this.handlePointerMoveCapture_ = (event: PointerEvent) => {
                if (this.marqueeStartScreen_) {
                    this.updateMarqueeState_(event);
                    return;
                }

                if (this.isEditModeEnabled_ && !this.pendingDragAtom_ && !this.isDraggingAtom_) {
                    this.updateHoverFromPointer_(event);
                }

                if (!this.pendingDragAtom_) return;

                if (!this.isDraggingAtom_) {
                    if (!this.pointerDownPosition_) return;
                    const distance = Math.sqrt(
                        (event.clientX - this.pointerDownPosition_.x) ** 2 +
                            (event.clientY - this.pointerDownPosition_.y) ** 2,
                    );
                    // Only commit to a drag once the pointer has moved a few pixels, so a plain
                    // click still falls through to handlePointerUpCapture_'s select-only path.
                    if (distance < DRAG_THRESHOLD_PX) return;
                    this.beginAtomDrag_(event);
                }

                if (!this.dragPlane_ || !this.dragOffset_) return;
                const point = this.getPointerPlaneIntersection(event, this.dragPlane_);
                if (!point) return;
                const newPosition = point.add(this.dragOffset_);

                // applyGroupDragDelta_ (GroupTransformMixin) also keeps the gizmo (attached to
                // the pivot, not to any one dragged mesh) visually tracking the group instead of
                // staying frozen at the pre-drag centroid for the whole gesture.
                if (!this.applyGroupDragDelta_(newPosition)) {
                    this.pendingDragAtom_.position.copy(newPosition);
                }
                this.syncHighlightPoolTo_(this.selectedMeshes_);
                this.render();
            };

            this.handlePointerUpCapture_ = (event: PointerEvent) => {
                if (this.marqueeStartScreen_) {
                    this.finishMarqueeSelection_(event);
                    return;
                }

                if (this.isDraggingAtom_ && this.pendingDragAtom_) {
                    this.endAtomDrag_();
                    return;
                }
                this.pendingDragAtom_ = null;

                if (!this.pointerDownPosition_) return;
                const distance = Math.sqrt(
                    (event.clientX - this.pointerDownPosition_.x) ** 2 +
                        (event.clientY - this.pointerDownPosition_.y) ** 2,
                );
                // Perform raycasting selection only if pointer movement is negligible (less than
                // DRAG_THRESHOLD_PX)
                if (distance < DRAG_THRESHOLD_PX) {
                    this.handlePointerDown(event);
                }
                this.pointerDownPosition_ = null;
            };

            // A pointercancel (browser/OS interrupts the gesture - e.g. a tab switch mid-drag)
            // must abandon the drag exactly like Esc: revert position, commit nothing.
            this.handlePointerCancelCapture_ = () => {
                if (this.marqueeStartScreen_) {
                    this.hideMarqueeOverlay_();
                    this.marqueeStartScreen_ = null;
                    this.isMarqueeSelecting_ = false;
                } else if (this.isDraggingAtom_) {
                    this.cancelAtomDrag_();
                } else {
                    this.pendingDragAtom_ = null;
                    this.pointerDownPosition_ = null;
                }
            };

            this.renderer.domElement.addEventListener(
                "pointerdown",
                this.handlePointerDownCapture_,
            );
            this.renderer.domElement.addEventListener(
                "pointermove",
                this.handlePointerMoveCapture_,
            );
            this.renderer.domElement.addEventListener("pointerup", this.handlePointerUpCapture_);
            this.renderer.domElement.addEventListener(
                "pointercancel",
                this.handlePointerCancelCapture_,
            );

            this.handleEditModeKeyDown_ = (event: KeyboardEvent) => {
                if (!this.isEditModeEnabled_) return;
                // Don't act on Escape/F while the user is typing in a form field (e.g. the
                // coordinate panel or the element-rename field) - "f" in particular is a normal
                // character a user might type there (e.g. renaming an atom to "Fe").
                const target = event.target as HTMLElement | null;
                if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.nodeName)) return;

                if (event.key === "Escape") {
                    if (this.isDraggingAtom_ || this.transformControls_?.dragging) {
                        this.cancelAtomDrag_();
                    } else if (this.selectedMeshes_.length > 0) {
                        this.clearSelection();
                        if (this.settings.onSelectionChanged) {
                            this.settings.onSelectionChanged([]);
                        }
                        this.render();
                    }
                } else if (
                    event.key.toLowerCase() ===
                        this.settings.hotKeysConfig?.focusCameraOnSelection &&
                    this.selectedMeshes_.length > 0
                ) {
                    this.focusCameraOnSelection();
                }
            };
            document.addEventListener("keydown", this.handleEditModeKeyDown_);
        }

        /**
         * Updates the hover halo/cursor to whatever atom (if any) is under the pointer. Only
         * called while not already dragging/pending, so hover tracking never adds raycasts to
         * the hot path of an in-progress drag.
         */
        updateHoverFromPointer_(event: PointerEvent): void {
            const atomUnderPointer = this.getAtomAtPointer(event);
            if (atomUnderPointer === this.hoveredMesh_) return;
            this.hoveredMesh_ = atomUnderPointer;
            this.updateHighlightMesh_(this.hoverHighlightMesh_, atomUnderPointer);
            this.renderer.domElement.style.cursor = atomUnderPointer ? "move" : "";
            this.render();
        }

        // ---- Direct atom drag (single or, for a multi-selected atom, the whole group) -----
        //
        // Marquee (rubber-band) selection lives in MarqueeSelectionMixin (updateMarqueeState_,
        // showMarqueeOverlay_/updateMarqueeOverlay_/hideMarqueeOverlay_, getAtomsInScreenRect_,
        // finishMarqueeSelection_), called from the pointer capture handlers below.

        /**
         * Selects the pending atom and sets up the camera-facing drag plane through its current
         * position, offset so the atom doesn't jump to snap its center to the cursor. If the
         * pressed atom is already part of a multi-selection, the whole selection drags together
         * rigidly (matching standard multi-select conventions) instead of collapsing to just the
         * pressed atom.
         */
        beginAtomDrag_(event: PointerEvent): void {
            if (!this.pendingDragAtom_) return;
            this.isDraggingAtom_ = true;
            this.dragStartPosition_ = this.pendingDragAtom_.position.clone();

            this.isDraggingGroup_ =
                this.selectedMeshes_.length > 1 &&
                this.selectedMeshes_.includes(this.pendingDragAtom_);
            if (this.isDraggingGroup_) {
                this.captureGroupDragStartPositions_();
            } else {
                this.groupDragStartPositions_ = null;
                this.setSelectedAtomMesh(this.pendingDragAtom_);
                if (this.settings.onSelectionChanged) {
                    this.settings.onSelectionChanged([this.pendingDragAtom_.userData.atomicIndex]);
                }
            }

            this.orbitControlsEnabledBeforeDrag_ = this.orbitControls?.enabled ?? true;
            if (this.orbitControls) this.orbitControls.enabled = false;
            if (
                this.activePointerId_ !== null &&
                typeof this.renderer.domElement.setPointerCapture === "function"
            ) {
                this.renderer.domElement.setPointerCapture(this.activePointerId_);
            }
            this.hoveredMesh_ = null;
            this.updateHighlightMesh_(this.hoverHighlightMesh_, null);
            this.renderer.domElement.style.cursor = "grabbing";

            const cameraDirection = new THREE.Vector3();
            this.camera.getWorldDirection(cameraDirection);
            this.dragPlane_ = new THREE.Plane().setFromNormalAndCoplanarPoint(
                cameraDirection,
                this.pendingDragAtom_.position,
            );
            const startPoint = this.getPointerPlaneIntersection(event, this.dragPlane_);
            this.dragOffset_ = startPoint
                ? this.pendingDragAtom_.position.clone().sub(startPoint)
                : new THREE.Vector3();
        }

        /**
         * Finalizes a direct atom (or group) drag: restores camera orbiting and commits the
         * moved atom(s) as a single delta applied to the current material (see
         * commitMovedAtom_/commitMovedAtoms_) - one history entry regardless of how many atoms
         * moved.
         */
        endAtomDrag_(): void {
            const atom = this.pendingDragAtom_;
            const wasGroup = this.isDraggingGroup_;
            const groupMeshes = wasGroup ? [...this.selectedMeshes_] : null;
            this.releaseActiveDragPointer_();
            this.isDraggingAtom_ = false;
            this.isDraggingGroup_ = false;
            this.groupDragStartPositions_ = null;
            this.pendingDragAtom_ = null;
            this.pointerDownPosition_ = null;
            this.dragStartPosition_ = null;
            if (this.orbitControls)
                this.orbitControls.enabled = this.orbitControlsEnabledBeforeDrag_;
            this.renderer.domElement.style.cursor = "";

            if (wasGroup && groupMeshes) {
                this.commitMovedAtoms_(
                    groupMeshes.map((mesh) => ({
                        atomicIndex: mesh.userData.atomicIndex,
                        position: mesh.position.clone(),
                    })),
                    "drag",
                );
            } else if (atom) {
                this.commitMovedAtom_(atom.userData.atomicIndex, atom.position, "drag");
            }
        }

        /**
         * Abandons an in-progress direct atom (or group) drag (Esc / pointercancel): snaps every
         * dragged atom back to its pre-drag position and reports nothing - no history entry, no
         * callback.
         */
        cancelAtomDrag_(): void {
            // Covers all four drag shapes this mixin supports: a direct body-drag on one atom or
            // on a multi-selected group (isDraggingGroup_/pendingDragAtom_ below), and the
            // gizmo-driven equivalent of either (a lone atom or the group pivot attached to
            // TransformControls, handled here via draggedObject). Without this branch, Esc during
            // a gizmo drag - translate mode's default interaction - reverted nothing: it silently
            // continued dragging (TransformControls had no idea Esc was pressed), and on the
            // eventual real mouseup committed a delta the user had just tried to cancel.
            const draggedObject = this.transformControls_?.dragging
                ? this.transformControls_.object
                : null;

            if (draggedObject === this.selectionPivot_ && this.groupDragStartPositions_) {
                this.selectedMeshes_.forEach((mesh: THREE.Mesh) => {
                    const start = this.groupDragStartPositions_?.get(mesh);
                    if (start) mesh.position.copy(start);
                });
                if (this.transformDragStartPosition_) {
                    this.selectionPivot_?.position.copy(this.transformDragStartPosition_);
                }
                // Harmless no-op for a cancelled translate (the pivot's quaternion never left
                // identity); for a cancelled rotate this is the actual revert, mirroring the
                // commit path's own post-rotate reset.
                this.selectionPivot_?.quaternion.identity();
                this.syncHighlightPoolTo_(this.selectedMeshes_);
                this.render();
            } else if (draggedObject && this.transformDragStartPosition_) {
                draggedObject.position.copy(this.transformDragStartPosition_);
                if (this.transformDragStartQuaternion_) {
                    draggedObject.quaternion.copy(this.transformDragStartQuaternion_);
                }
                this.syncHighlightPoolTo_(this.selectedMeshes_);
                this.render();
            } else if (this.isDraggingGroup_ && this.groupDragStartPositions_) {
                this.selectedMeshes_.forEach((mesh: THREE.Mesh) => {
                    const start = this.groupDragStartPositions_?.get(mesh);
                    if (start) mesh.position.copy(start);
                });
                this.syncHighlightPoolTo_(this.selectedMeshes_);
                this.render();
            } else if (this.pendingDragAtom_ && this.dragStartPosition_) {
                this.pendingDragAtom_.position.copy(this.dragStartPosition_);
                this.syncHighlightPoolTo_(this.selectedMeshes_);
                this.render();
            }

            // Setting dragging = false is a no-op if it's already false (TransformControls' own
            // property setter only dispatches when the value actually changes - see its
            // defineProperty helper), so this is safe to call unconditionally even for a
            // non-gizmo cancel. For a real gizmo cancel, it's also sufficient on its own to halt
            // TransformControls' further internal pointerMove/pointerUp handling - both
            // early-return once `dragging` reads false, per its source - even though the real
            // mouse button may still be physically held; the auto-fired "dragging-changed" event
            // this triggers is what restores orbitControls.enabled and clears
            // transformDragStartPosition_/Quaternion_ below (read above, before this point).
            if (this.transformControls_) this.transformControls_.dragging = false;
            this.releaseActiveDragPointer_();
            this.isDraggingAtom_ = false;
            this.isDraggingGroup_ = false;
            this.groupDragStartPositions_ = null;
            this.pendingDragAtom_ = null;
            this.pointerDownPosition_ = null;
            this.dragStartPosition_ = null;
            if (this.orbitControls)
                this.orbitControls.enabled = this.orbitControlsEnabledBeforeDrag_;
            this.renderer.domElement.style.cursor = "";
        }

        releaseActiveDragPointer_(): void {
            if (
                this.activePointerId_ !== null &&
                typeof this.renderer.domElement.releasePointerCapture === "function" &&
                typeof this.renderer.domElement.hasPointerCapture === "function" &&
                this.renderer.domElement.hasPointerCapture(this.activePointerId_)
            ) {
                this.renderer.domElement.releasePointerCapture(this.activePointerId_);
            }
            this.activePointerId_ = null;
        }

        /**
         * Points this.raycaster_ from the camera through the given pointer event's position,
         * converted to Normalized Device Coordinates (NDC).
         */
        updateRaycasterFromPointer_(event: PointerEvent): void {
            if (!this.pointer_ || !this.raycaster_) return;
            const boundingRectangle = this.renderer.domElement.getBoundingClientRect();
            this.pointer_.x =
                ((event.clientX - boundingRectangle.left) / boundingRectangle.width) * 2 - 1;
            this.pointer_.y =
                -((event.clientY - boundingRectangle.top) / boundingRectangle.height) * 2 + 1;
            this.raycaster_.setFromCamera(this.pointer_, this.camera);
        }

        /**
         * Raycasts from the given pointer event through the atoms in the scene.
         * @returns the frontmost hit atom mesh, or null if none was hit.
         */
        getAtomAtPointer(event: PointerEvent): THREE.Mesh | null {
            if (!this.pointer_ || !this.raycaster_) return null;
            this.updateRaycasterFromPointer_(event);
            const intersections = this.raycaster_.intersectObjects(this.collectSelectableAtoms());
            return intersections.length > 0 ? (intersections[0].object as THREE.Mesh) : null;
        }

        /**
         * Raycasts from the given pointer event and intersects it with the given plane.
         * @returns the intersection point, or null if the ray is parallel to the plane.
         */
        getPointerPlaneIntersection(event: PointerEvent, plane: THREE.Plane): THREE.Vector3 | null {
            if (!this.pointer_ || !this.raycaster_) return null;
            this.updateRaycasterFromPointer_(event);
            const target = new THREE.Vector3();
            return this.raycaster_.ray.intersectPlane(plane, target) ? target : null;
        }

        /**
         * Handles a plain click (no drag) on the canvas to select an atom mesh and attach the
         * transform gizmo, or to deselect when clicking empty space. Shift+click adds to the
         * current selection, Ctrl/Cmd+click toggles a single atom in/out of it; Shift/Ctrl+click
         * on empty space is a no-op (the current selection is left alone rather than being
         * surprisingly cleared mid-multi-select).
         * @param {PointerEvent} event - Native browser pointer event.
         */
        handlePointerDown(event: PointerEvent): void {
            if (!this.isEditModeEnabled_) return;

            // Block new selection raycasts if the user is already interacting with the TransformControls handles
            if (this.transformControls_ && this.transformControls_.dragging) return;

            const selectedAtomMesh = this.getAtomAtPointer(event);
            if (selectedAtomMesh) {
                const isAlreadySelected = this.selectedMeshes_.includes(selectedAtomMesh);
                let nextSelection: THREE.Mesh[];
                if (event.ctrlKey || event.metaKey) {
                    nextSelection = isAlreadySelected
                        ? this.selectedMeshes_.filter(
                              (mesh: THREE.Mesh) => mesh !== selectedAtomMesh,
                          )
                        : [...this.selectedMeshes_, selectedAtomMesh];
                } else if (event.shiftKey) {
                    nextSelection = isAlreadySelected
                        ? this.selectedMeshes_
                        : [...this.selectedMeshes_, selectedAtomMesh];
                } else {
                    nextSelection = [selectedAtomMesh];
                }
                this.setSelectedAtomMeshes(nextSelection);
                if (this.settings.onSelectionChanged) {
                    this.settings.onSelectionChanged(
                        nextSelection.map((mesh) => mesh.userData.atomicIndex),
                    );
                }
                this.render();
            } else if (!event.shiftKey && !event.ctrlKey && !event.metaKey) {
                // Clicking on empty space (with no modifier) detaches the transform controls gizmo
                this.clearSelection();
                if (this.settings.onSelectionChanged) {
                    this.settings.onSelectionChanged([]);
                }
                this.render();
            }
        }

        /**
         * Highlights the given atom mesh and attaches the transform gizmo to it. Thin
         * single-atom wrapper over setSelectedAtomMeshes, kept for callers/tests that only ever
         * deal with one atom at a time.
         */
        setSelectedAtomMesh(atomMesh: THREE.Mesh): void {
            this.setSelectedAtomMeshes([atomMesh]);
        }

        /**
         * Sets the full multi-atom selection: highlights every selected atom via the halo pool,
         * and attaches the gizmo directly to the sole atom (single selection) or to a pivot at
         * the selection's centroid (2+ atoms), so a group drag moves every selected atom rigidly
         * (see beginAtomDrag_/the TransformControls "change"/"mouseUp" listeners).
         */
        setSelectedAtomMeshes(meshes: THREE.Mesh[]): void {
            this.selectedMeshes_ = meshes;
            this.selectedMesh_ = meshes.length > 0 ? meshes[meshes.length - 1] : null;
            if (meshes.length > 0) {
                this.lastSelectedAtomicIndices_ = meshes.map((mesh) => mesh.userData.atomicIndex);
            }
            this.syncHighlightPoolTo_(meshes);

            if (meshes.length === 0) {
                if (this.transformControls_) this.transformControls_.detach();
            } else if (meshes.length === 1) {
                if (this.transformControls_) this.transformControls_.attach(meshes[0]);
            } else {
                this.attachPivotToSelection_();
            }
        }

        /**
         * Clears the current atom selection, removes its highlight(s), and detaches the gizmo.
         * @param {boolean} forgetLastSelection - Also forget the remembered indices used to
         * restore selection when edit mode is re-enabled (see enableEditMode). Defaults to true
         * for an explicit user deselect; enableEditMode(false) passes false so toggling edit
         * mode off and back on preserves the selection (R12).
         */
        clearSelection(forgetLastSelection = true): void {
            this.setSelectedAtomMeshes([]);
            if (forgetLastSelection) this.lastSelectedAtomicIndices_ = null;
        }

        /**
         * Single-atom-named alias for clearSelection, kept for existing callers/tests.
         */
        clearSelectedAtom(forgetLastSelection = true): void {
            this.clearSelection(forgetLastSelection);
        }

        /**
         * Re-attaches the selection/gizmo to the atom meshes with the given atomicIndices.
         * Used after a scene rebuild, since rebuilding replaces every atom mesh instance and
         * would otherwise leave the gizmo attached to mesh(es) that no longer exist in the scene.
         * Clears the selection if none of the given indices match any atom any more (e.g. it was
         * deleted). Indices with no match are silently dropped rather than clearing everything,
         * so removing one atom out of a multi-selection keeps the rest selected.
         *
         * The sole place that notifies onSelectionChanged for a reselect, and only when the
         * result actually differs from what was selected going in - critically, this covers
         * rebuildScene() (wave.js), which calls this on every rebuild (including one triggered by
         * undo/redo, which can shift or remove indices out from under an unrelated rebuild) but
         * has no way to notify the host itself. Without this, undo/redo across an add/remove
         * boundary left the host's selection state pointing at an atomicIndex that had silently
         * stopped existing on the wave side. Callers that already know their own new selection
         * (addAtom, cloneSelectedAtoms, enableEditMode's restore) used to fire this explicitly
         * too; that's now redundant and has been removed to keep this the single source of truth.
         */
        reselectAtomsByIndices(
            atomicIndices: Array<number | null | undefined> | null | undefined,
        ): void {
            if (!atomicIndices || atomicIndices.length === 0) return;
            const validIndices = atomicIndices.filter(
                (index): index is number => index !== null && index !== undefined,
            );
            if (validIndices.length === 0) return;
            const previousIndices = this.selectedMeshes_.map(
                (mesh: THREE.Mesh) => mesh.userData.atomicIndex,
            );
            const matches = this.collectSelectableAtoms().filter((atom: THREE.Mesh) =>
                validIndices.includes(atom.userData.atomicIndex),
            );
            this.setSelectedAtomMeshes(matches);

            const resultIndices = matches.map((atom: THREE.Mesh) => atom.userData.atomicIndex);
            const isUnchanged =
                resultIndices.length === previousIndices.length &&
                resultIndices.every((index: number) => previousIndices.includes(index));
            if (!isUnchanged && this.settings.onSelectionChanged) {
                this.settings.onSelectionChanged(resultIndices);
            }
        }

        /**
         * Single-index-named alias for reselectAtomsByIndices, kept for existing callers/tests.
         */
        reselectAtomByIndex(atomicIndex: number | null | undefined): void {
            this.reselectAtomsByIndices([atomicIndex]);
        }

        /**
         * Enables or disables edit mode interactions and controls visibility. Disabling
         * preserves the selection's indices (see clearSelection) so re-enabling edit mode
         * restores it (R12) rather than always starting deselected. While enabled, remaps the
         * OrbitControls left mouse button off (freeing it for marquee-select on empty space) and
         * moves camera rotation onto the right mouse button (decision D-4); the defaults are
         * restored on disable.
         *
         * Touch gets the same treatment for the same reason (U-13). OrbitControls' default
         * `touches.ONE` is ROTATE, which is the finger the editor needs for selecting, dragging an
         * atom and marquee-selecting - so while edit mode is on, one finger belongs to the editor and
         * the camera moves to two fingers (DOLLY_ROTATE: pinch to zoom, twist to orbit). There is no
         * right button to move it to.
         * @param {boolean} enabled - True to enable, false to disable.
         */
        enableEditMode(enabled: boolean): void {
            this.isEditModeEnabled_ = enabled;
            if (this.orbitControls) {
                if (enabled) {
                    this.orbitControlsDefaultMouseButtons_ = { ...this.orbitControls.mouseButtons };
                    this.orbitControls.mouseButtons = {
                        ...this.orbitControls.mouseButtons,
                        LEFT: null,
                        RIGHT: THREE.MOUSE.ROTATE,
                    };
                    this.orbitControlsDefaultTouches_ = { ...this.orbitControls.touches };
                    this.orbitControls.touches = {
                        // OrbitControls switches on `touches.ONE` and falls through to STATE.NONE
                        // for anything it does not recognise, which is how a one-finger gesture is
                        // handed to the editor - the same "no camera on this input" intent as
                        // LEFT: null above, expressed the only way the touch path allows.
                        ONE: ONE_FINGER_RESERVED_FOR_EDITING,
                        TWO: THREE.TOUCH.DOLLY_ROTATE,
                    };
                } else {
                    if (this.orbitControlsDefaultMouseButtons_) {
                        this.orbitControls.mouseButtons = this.orbitControlsDefaultMouseButtons_;
                        this.orbitControlsDefaultMouseButtons_ = null;
                    }
                    if (this.orbitControlsDefaultTouches_) {
                        this.orbitControls.touches = this.orbitControlsDefaultTouches_;
                        this.orbitControlsDefaultTouches_ = null;
                    }
                }
            }

            if (!enabled) {
                if (this.isDraggingAtom_) this.cancelAtomDrag_();
                if (this.isMarqueeSelecting_ || this.marqueeStartScreen_) {
                    this.hideMarqueeOverlay_();
                    this.marqueeStartScreen_ = null;
                    this.isMarqueeSelecting_ = false;
                }
                this.hoveredMesh_ = null;
                this.updateHighlightMesh_(this.hoverHighlightMesh_, null);
                this.renderer.domElement.style.cursor = "";
                if (this.transformControls_) {
                    this.clearSelection(false);
                    if (this.settings.onSelectionChanged) {
                        this.settings.onSelectionChanged([]);
                    }
                    this.render();
                }
            } else if (this.lastSelectedAtomicIndices_) {
                // reselectAtomsByIndices fires onSelectionChanged itself when this actually
                // restores a selection (selectedMeshes_ is empty at this point, from the disable
                // branch's clearSelection(false) above, so the restore always counts as changed).
                this.reselectAtomsByIndices(this.lastSelectedAtomicIndices_);
            }
        }

        /**
         * Shorthand for disabling edit mode.
         */
        disableEditMode(): void {
            this.enableEditMode(false);
        }

        /**
         * Updates the TransformControls mode (translate, rotate).
         * @param {string} mode - Mode name ("translate" or "rotate").
         */
        setTransformMode(mode: "translate" | "rotate"): void {
            if (this.transformControls_) {
                this.transformControls_.setMode(mode);
            }
        }

        /**
         * Re-points the edit gizmo at the newly active camera so dragging keeps working
         * after the user switches between perspective and orthographic projection.
         */
        toggleOrthographicCamera(): void {
            super.toggleOrthographicCamera();
            if (this.transformControls_) {
                this.transformControls_.camera = this.camera;
            }
        }

        /**
         * Applies a basis mutation to a clone of the wave's own current structure, preserving
         * its lattice, units, metadata, labels, magnetic moments, and constraints exactly -
         * only the fields the callback actually touches change. This replaces re-deriving the
         * whole material from the live Three.js scene on every edit (ThreeDSceneDataToMaterial),
         * which was a lossy round trip: it reintroduced the lattice to only ~1e-7 precision
         * (causing spurious camera resets, D1) and could pick up bond/boundary/repetition meshes
         * as phantom atoms (D5) - a class of bug that a delta applied to the known material
         * cannot reintroduce, because the lattice and every untouched atom are never recomputed.
         */
        applyBasisDelta_(mutateBasis: (basis: any) => void): any {
            const updatedMaterial = this.structure.clone();
            const basis = updatedMaterial.getBasis();
            mutateBasis(basis);
            updatedMaterial.setBasis(basis.toJSON());
            return updatedMaterial;
        }

        /**
         * Adds an atom to the structure and triggers scene reconstruction. The new atom is
         * auto-selected once the scene has rebuilt around the updated material.
         * @param {string} elementName - Chemical element symbol (e.g. "Si").
         * @param {Array<number>} cartesianCoordinates - [x, y, z] position in Cartesian space.
         */
        addAtom(elementName: string, cartesianCoordinates: Coordinate3D): void {
            const newMaterial = this.applyBasisDelta_((basis: any) => {
                const coordinate = basis.isInCartesianUnits
                    ? cartesianCoordinates
                    : basis.cell.convertPointToCrystal(cartesianCoordinates);
                basis.addAtom({ element: elementName, coordinate });
            });
            const newIndex = newMaterial.getBasis().elements.length - 1;

            this.setStructure(newMaterial);
            this.structureGroup.name = (newMaterial as any).name || (newMaterial as any).formula;
            this.rebuildScene();
            // reselectAtomByIndex fires onSelectionChanged itself (the new atom always differs
            // from whatever was selected before Add Atom ran).
            this.reselectAtomByIndex(newIndex);

            if (this.settings.onStructureModified) {
                this.settings.onStructureModified(newMaterial, "add");
            }
        }

        /**
         * Removes the currently selected atom(s) from the structure - the whole multi-selection
         * if 2+ atoms are selected (as one commit, one history entry), or the single selected
         * atom otherwise.
         */
        removeSelectedAtom(): void {
            if (this.selectedMeshes_.length > 1) {
                this.removeSelectedAtoms_();
                return;
            }
            if (!this.selectedMesh_) return;
            const targetIndex = this.selectedMesh_.userData.atomicIndex;

            const newMaterial = this.applyBasisDelta_((basis: any) => {
                const removedId = basis.elements[targetIndex]?.id;
                basis.elements = basis.elements.filter(
                    (_element: any, index: number) => index !== targetIndex,
                );
                basis.coordinates = basis.coordinates.filter(
                    (_coordinate: any, index: number) => index !== targetIndex,
                );
                if (basis.labels?.length) {
                    basis.labels = basis.labels.filter((label: any) => label.id !== removedId);
                }
                if (basis.magneticMoments?.length) {
                    basis.magneticMoments = basis.magneticMoments.filter(
                        (magneticMoment: any) => magneticMoment.id !== removedId,
                    );
                }
                if (basis.constraints?.length) {
                    basis.constraints = basis.constraints.filter(
                        (constraint: any) => constraint.id !== removedId,
                    );
                }
            });

            this.clearSelection();
            if (this.settings.onSelectionChanged) {
                this.settings.onSelectionChanged([]);
            }

            this.setStructure(newMaterial);
            this.structureGroup.name = (newMaterial as any).name || (newMaterial as any).formula;
            this.rebuildScene();

            if (this.settings.onStructureModified) {
                this.settings.onStructureModified(newMaterial, "remove");
            }
        }

        /**
         * Removes every currently multi-selected atom as a single delta/commit.
         */
        removeSelectedAtoms_(): void {
            const targetIndices = new Set<number>(
                this.selectedMeshes_.map((mesh: THREE.Mesh) => mesh.userData.atomicIndex),
            );
            if (targetIndices.size === 0) return;

            const newMaterial = this.applyBasisDelta_((basis: any) => {
                const removedIds = new Set(
                    [...targetIndices]
                        .map((index) => basis.elements[index]?.id)
                        .filter((id) => id !== undefined),
                );
                basis.elements = basis.elements.filter(
                    (_element: any, index: number) => !targetIndices.has(index),
                );
                basis.coordinates = basis.coordinates.filter(
                    (_coordinate: any, index: number) => !targetIndices.has(index),
                );
                if (basis.labels?.length) {
                    basis.labels = basis.labels.filter((label: any) => !removedIds.has(label.id));
                }
                if (basis.magneticMoments?.length) {
                    basis.magneticMoments = basis.magneticMoments.filter(
                        (magneticMoment: any) => !removedIds.has(magneticMoment.id),
                    );
                }
                if (basis.constraints?.length) {
                    basis.constraints = basis.constraints.filter(
                        (constraint: any) => !removedIds.has(constraint.id),
                    );
                }
            });

            this.clearSelection();
            if (this.settings.onSelectionChanged) {
                this.settings.onSelectionChanged([]);
            }

            this.setStructure(newMaterial);
            this.structureGroup.name = (newMaterial as any).name || (newMaterial as any).formula;
            this.rebuildScene();

            if (this.settings.onStructureModified) {
                this.settings.onStructureModified(newMaterial, "remove");
            }
        }

        /**
         * Duplicates every selected atom at a small offset from its source, preserving element
         * and (for the group case) relative positions, as a single commit. The clones become the
         * new selection, matching Add Atom's auto-select behavior. Old-editor parity: its "clone
         * existing" was one of only two ways to add an atom of a specific element, the other
         * being a plain add-then-rename (see changeAtomElement / D-9).
         *
         * Shares Add Atom's occupied-site guard (D22): the offset nudges further along the same
         * diagonal until clear of every existing atom (and of any sibling clone already placed
         * earlier in this same call, so cloning several selected atoms at once can't collide with
         * each other either), so cloning the same atom repeatedly doesn't silently stack
         * coincident duplicates.
         */
        cloneSelectedAtoms(): void {
            if (this.selectedMeshes_.length === 0) return;
            const OCCUPIED_TOLERANCE = 0.5; // Å; below any realistic bond length
            const OFFSET_STEP = new THREE.Vector3(0.3, 0.3, 0.3);
            const MAX_OFFSET_ATTEMPTS = 10;
            const { elements } = this.structure.basis;
            // this.basis (AtomsMixin) is kept in Cartesian units from setStructure() onward -
            // exactly the space CLONE_OFFSET/OCCUPIED_TOLERANCE are defined in.
            const existingPositions: THREE.Vector3[] = this.basis.coordinatesAsArray.map(
                (coordinate: number[]) => new THREE.Vector3(...coordinate),
            );

            const placedPositions: THREE.Vector3[] = [];
            const isOccupied = (position: THREE.Vector3) =>
                existingPositions
                    .concat(placedPositions)
                    .some((existing) => existing.distanceTo(position) < OCCUPIED_TOLERANCE);

            const sourceAtoms = this.selectedMeshes_.map((mesh: THREE.Mesh) => {
                const elementEntry = elements[mesh.userData.atomicIndex];
                const element =
                    typeof elementEntry === "string" ? elementEntry : elementEntry?.value ?? "Si";
                let attempts = 1;
                let candidate = mesh.position.clone().add(OFFSET_STEP);
                while (isOccupied(candidate) && attempts < MAX_OFFSET_ATTEMPTS) {
                    attempts += 1;
                    candidate = mesh.position
                        .clone()
                        .add(OFFSET_STEP.clone().multiplyScalar(attempts));
                }
                placedPositions.push(candidate);
                return { element, position: candidate };
            });

            const newMaterial = this.applyBasisDelta_((basis: any) => {
                sourceAtoms.forEach(({ element, position }: any) => {
                    const coordinate = basis.isInCartesianUnits
                        ? position.toArray()
                        : basis.cell.convertPointToCrystal(position.toArray());
                    basis.addAtom({ element, coordinate });
                });
            });

            const startIndex = newMaterial.getBasis().elements.length - sourceAtoms.length;
            const newIndices = sourceAtoms.map((_atom: any, index: number) => startIndex + index);

            this.setStructure(newMaterial);
            this.rebuildScene();
            // reselectAtomsByIndices fires onSelectionChanged itself (the clones always differ
            // from whatever was selected going in).
            this.reselectAtomsByIndices(newIndices);
            if (this.settings.onStructureModified) {
                this.settings.onStructureModified(newMaterial, "clone");
            }
        }

        /**
         * Frames the camera on the current selection's bounding sphere, preserving the current
         * viewing angle (only re-targeting and re-distancing, not resetting to a canonical
         * axis-aligned view like adjustCamerasAndOrbitControlsToCell does for the whole cell).
         * The one camera move an edit-mode interaction is allowed to make, since it's a direct,
         * explicit user action (F key) rather than a side effect of an edit (US-12).
         */
        focusCameraOnSelection(): void {
            if (this.selectedMeshes_.length === 0 || !this.orbitControls) return;

            const boundingBox = new THREE.Box3();
            this.selectedMeshes_.forEach((mesh: THREE.Mesh) =>
                boundingBox.expandByPoint(mesh.position),
            );
            const center = boundingBox.getCenter(new THREE.Vector3());
            const extent = boundingBox.getSize(new THREE.Vector3()).length();
            const MIN_FOCUS_RADIUS = 2; // Å; keeps a single-atom focus from zooming in absurdly close
            const radius = Math.max(extent / 2, MIN_FOCUS_RADIUS);

            const previousTarget = this.orbitControls.target.clone();
            const viewDirection = this.camera.position.clone().sub(previousTarget);
            if (viewDirection.lengthSq() < 1e-9) viewDirection.set(0, 0, 1);
            viewDirection.normalize();

            if (this.camera.isOrthographicCamera) {
                this.setOrthographicCameraFrustum(this.PADDING_RATIO * radius * 2);
                this.camera.position.copy(
                    center.clone().add(viewDirection.multiplyScalar(Math.max(radius * 4, 10))),
                );
            } else {
                const fovInRadians = (this.camera.fov * Math.PI) / 180;
                const distance = (this.PADDING_RATIO * radius * 2) / Math.tan(fovInRadians / 2);
                this.camera.position.copy(
                    center.clone().add(viewDirection.multiplyScalar(distance)),
                );
            }

            this.orbitControls.target.copy(center);
            this.camera.lookAt(center);
            this.orbitControls.update();
            this.render();
        }

        /**
         * Commits a single moved atom (from either a direct drag or a gizmo drag) as one delta
         * applied to the current material, then rebuilds the scene around it. rebuildScene()
         * itself preserves the selection/gizmo across the rebuild when in edit mode (see
         * wave.js), so no explicit reselect is needed here for the move case.
         */
        commitMovedAtom_(
            atomicIndex: number,
            cartesianPosition: THREE.Vector3,
            source: string,
        ): void {
            this.commitMovedAtoms_([{ atomicIndex, position: cartesianPosition }], source);
        }

        /**
         * Commits any number of moved atoms as a single delta/commit (one history entry) applied
         * to the current material, then rebuilds the scene around it. `source` (spec Sec6.2's
         * onEditCommit contract - "drag" for a direct body-drag, "gizmo" for a TransformControls
         * drag) is forwarded to onStructureModified so ThreeDEditor.jsx can pass it on to a host's
         * onEditCommit without having to re-infer which gesture produced this commit.
         */
        commitMovedAtoms_(
            moves: Array<{ atomicIndex: number; position: THREE.Vector3 }>,
            source: string,
        ): void {
            if (!moves.length) return;
            const newMaterial = this.applyBasisDelta_((basis: any) => {
                const { coordinates } = basis;
                moves.forEach(({ atomicIndex, position }) => {
                    if (!coordinates[atomicIndex]) return;
                    const value = basis.isInCartesianUnits
                        ? position.toArray()
                        : basis.cell.convertPointToCrystal(position.toArray());
                    coordinates[atomicIndex] = {
                        ...coordinates[atomicIndex],
                        value,
                    };
                });
                basis.coordinates = coordinates;
            });

            this.setStructure(newMaterial);
            this.rebuildScene();

            if (this.settings.onStructureModified) {
                this.settings.onStructureModified(newMaterial, source);
            }
        }

        /**
         * Lifecycle hook to dispose event listeners and objects on visualizer destruction.
         */
        dispose(): void {
            if (this.renderer && this.renderer.domElement) {
                if (this.handlePointerDownCapture_) {
                    this.renderer.domElement.removeEventListener(
                        "pointerdown",
                        this.handlePointerDownCapture_,
                    );
                }
                if (this.handlePointerMoveCapture_) {
                    this.renderer.domElement.removeEventListener(
                        "pointermove",
                        this.handlePointerMoveCapture_,
                    );
                }
                if (this.handlePointerUpCapture_) {
                    this.renderer.domElement.removeEventListener(
                        "pointerup",
                        this.handlePointerUpCapture_,
                    );
                }
                if (this.handlePointerCancelCapture_) {
                    this.renderer.domElement.removeEventListener(
                        "pointercancel",
                        this.handlePointerCancelCapture_,
                    );
                }
            }
            if (this.handleEditModeKeyDown_) {
                document.removeEventListener("keydown", this.handleEditModeKeyDown_);
            }
            if (this.transformControls_) {
                this.transformControls_.dispose();
            }
            [...this.selectionHighlightPool_, this.hoverHighlightMesh_].forEach((haloMesh) => {
                if (!haloMesh) return;
                this.scene.remove(haloMesh);
                haloMesh.geometry.dispose();
                (haloMesh.material as THREE.Material).dispose();
            });
            if (this.marqueeOverlayElement_) {
                this.marqueeOverlayElement_.remove();
                this.marqueeOverlayElement_ = null;
            }
            if (super.dispose) super.dispose();
        }
    };
