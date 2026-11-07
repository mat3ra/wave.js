import expect from "expect";
import * as THREE from "three";

import settings from "../../../src/settings";
import { getFeOWaveInstance, getWaveInstance } from "../../enums";
import {
    getWaveWithRecordedCallbacks,
    projectMeshToScreen,
    simulateAtomDrag,
    simulateClick,
    simulateMarqueeSelect,
    stubCanvasRect,
} from "../../helpers/editor";
import { getEventObjectBy3DPosition } from "../../utils";

describe("Interactive structure editor functionality tests", () => {
    test("Default state - edit mode disabled", () => {
        const wave = getWaveInstance({});
        expect(wave.isEditModeEnabled_).toBe(false);
    });

    test("Enabling and disabling edit mode", () => {
        const wave = getWaveInstance({});
        expect(wave.isEditModeEnabled_).toBe(false);

        wave.enableEditMode(true);
        expect(wave.isEditModeEnabled_).toBe(true);

        wave.disableEditMode();
        expect(wave.isEditModeEnabled_).toBe(false);
    });

    test("Toggling transform mode on TransformControls", () => {
        const wave = getWaveInstance({});
        wave.enableEditMode(true);

        // Check default translation mode
        expect(wave.transformControls_.mode).toBe("translate");

        // Switch to rotation mode
        wave.setTransformMode("rotate");
        expect(wave.transformControls_.mode).toBe("rotate");
    });

    test("Adding an atom mesh to structure group", () => {
        let callbackFired = false;
        let callbackMaterial = null;

        const wave = getWaveInstance({
            onStructureModified: (material) => {
                callbackFired = true;
                callbackMaterial = material;
            },
        });

        const initialAtomCount = wave.collectSelectableAtoms().length;

        // Add atom at the cell center coordinate
        wave.addAtom("Si", [0.0, 0.0, 0.0]);

        const updatedAtomCount = wave.collectSelectableAtoms().length;
        expect(updatedAtomCount).toBe(initialAtomCount + 1);
        expect(callbackFired).toBe(true);

        const lastElement = callbackMaterial.basis.elements[updatedAtomCount - 1];
        const elementSymbol = typeof lastElement === "string" ? lastElement : lastElement.value;
        expect(elementSymbol).toBe("Si");

        // Every element (including the pre-existing ones) must round-trip to a plain string,
        // not a doubly-wrapped {id, value: {id, value}} ESSE object - that shape isn't a valid
        // React child and crashes any UI that renders it directly (e.g. the coordinate panel).
        callbackMaterial.basis.elements.forEach((element) => {
            const symbol = typeof element === "string" ? element : element.value;
            expect(typeof symbol).toBe("string");
        });
    });

    test("Adding an atom preserves the material's original units and pre-existing atoms exactly", () => {
        // MATERIAL_CONFIG's basis is in crystal (fractional) units. The delta-based addAtom
        // (applyBasisDelta_) must never force the whole basis into cartesian units just because
        // the new atom's position was supplied in cartesian - it converts internally to place
        // the new atom, then converts back, so pre-existing atoms are untouched and the basis
        // keeps reporting its original units (D7).
        let callbackMaterial = null;
        const wave = getWaveInstance({
            onStructureModified: (material) => {
                callbackMaterial = material;
            },
        });

        wave.addAtom("Si", [0, 0, 0]);

        expect(callbackMaterial.basis.units).toBe("crystal");

        // MATERIAL_CONFIG has two pre-existing atoms, at crystal [0,0,0] and [0.25,0.25,0.25];
        // the new atom is appended at index 2.
        const [first, second, added] = callbackMaterial.basis.coordinates;
        const toValue = (coordinate) => (Array.isArray(coordinate) ? coordinate : coordinate.value);

        expect(toValue(first)).toEqual([0, 0, 0]);
        expect(toValue(second)).toEqual([0.25, 0.25, 0.25]);
        // Cartesian [0,0,0] is crystal [0,0,0] regardless of lattice, for any lattice.
        toValue(added).forEach((component) => expect(component).toBeCloseTo(0, 6));
    });

    test("Removing a selected atom mesh from structure group", () => {
        let callbackFired = false;
        let callbackMaterial = null;

        const wave = getWaveInstance({
            onStructureModified: (material) => {
                callbackFired = true;
                callbackMaterial = material;
            },
        });

        // Select the first atom mesh, the way handlePointerDown would on a real click.
        const [firstAtom] = wave.collectSelectableAtoms();
        expect(firstAtom.userData.atomicIndex).toBe(0);
        wave.selectedMesh_ = firstAtom;

        const initialAtomCount = wave.collectSelectableAtoms().length;

        wave.removeSelectedAtom();

        const updatedAtomCount = wave.collectSelectableAtoms().length;
        expect(updatedAtomCount).toBe(initialAtomCount - 1);
        expect(callbackMaterial.basis.elements.length).toBe(updatedAtomCount);
        expect(callbackFired).toBe(true);
        expect(wave.selectedMesh_).toBeNull();
    });

    test("Selection survives a scene rebuild while in edit mode", () => {
        const wave = getWaveInstance({});
        wave.enableEditMode(true);

        const [firstAtom] = wave.collectSelectableAtoms();
        wave.setSelectedAtomMesh(firstAtom);
        expect(wave.transformControls_.object).toBe(firstAtom);

        // rebuildScene() destroys and recreates every atom mesh (e.g. on a coordinate
        // edit, a drag, or an unrelated viewer setting change); the gizmo must follow
        // the same atom to its new mesh instance rather than staying attached to the
        // now-removed one.
        wave.rebuildScene();

        expect(wave.selectedMesh_).not.toBe(firstAtom);
        expect(wave.selectedMesh_.userData.atomicIndex).toBe(0);
        expect(wave.transformControls_.object).toBe(wave.selectedMesh_);
    });

    test("Click-and-drag directly on an atom (not the gizmo) moves it and reports the change", () => {
        let callbackMaterial = null;
        let selectedIndices = null;

        const wave = getWaveInstance({
            onStructureModified: (material) => {
                callbackMaterial = material;
            },
            // onSelectionChanged now reports an array of atomicIndices (D-4: multi-select) -
            // a single click/drag reports a one-element array.
            onSelectionChanged: (indices) => {
                selectedIndices = indices;
            },
        });
        wave.enableEditMode(true);

        // jsdom performs no layout, so getBoundingClientRect() would report a zero-size rect;
        // stub it to match the canvas' real drawing-buffer size so the raycasting math behaves
        // the way it would in a real browser.
        const canvas = wave.renderer.domElement;
        canvas.getBoundingClientRect = () => ({
            left: 0,
            top: 0,
            width: canvas.width,
            height: canvas.height,
        });

        const [firstAtom] = wave.collectSelectableAtoms();
        const startEvent = getEventObjectBy3DPosition(firstAtom.position, wave.camera, canvas);
        const startPosition = firstAtom.position.clone();

        wave.handlePointerDownCapture_({
            clientX: startEvent.layerX,
            clientY: startEvent.layerY,
        });
        expect(wave.pendingDragAtom_).toBe(firstAtom);
        expect(wave.isDraggingAtom_).toBe(false);

        // A few pixels of movement should not yet commit to a drag (matches the click-vs-drag
        // threshold used elsewhere for plain selection clicks).
        wave.handlePointerMoveCapture_({
            clientX: startEvent.layerX + 2,
            clientY: startEvent.layerY,
        });
        expect(wave.isDraggingAtom_).toBe(false);

        // Crossing the threshold commits to the drag: the offset between the cursor and the
        // atom's position is captured on this event, so the atom doesn't jump yet - it tracks
        // the cursor smoothly from here on, same as any offset-based drag implementation.
        wave.handlePointerMoveCapture_({
            clientX: startEvent.layerX + 40,
            clientY: startEvent.layerY,
        });
        expect(wave.isDraggingAtom_).toBe(true);
        expect(selectedIndices).toEqual([firstAtom.userData.atomicIndex]);
        expect(wave.transformControls_.object).toBe(firstAtom);

        // Further movement should now visibly move the atom.
        wave.handlePointerMoveCapture_({
            clientX: startEvent.layerX + 80,
            clientY: startEvent.layerY,
        });
        expect(firstAtom.position.equals(startPosition)).toBe(false);

        wave.handlePointerUpCapture_({
            clientX: startEvent.layerX + 40,
            clientY: startEvent.layerY,
        });
        expect(wave.isDraggingAtom_).toBe(false);
        expect(wave.pendingDragAtom_).toBeNull();
        expect(callbackMaterial).not.toBeNull();
    });

    test("A plain click on an atom does not trigger a drag", () => {
        const wave = getWaveInstance({});
        wave.enableEditMode(true);

        const canvas = wave.renderer.domElement;
        canvas.getBoundingClientRect = () => ({
            left: 0,
            top: 0,
            width: canvas.width,
            height: canvas.height,
        });

        const [firstAtom] = wave.collectSelectableAtoms();
        const clickEvent = getEventObjectBy3DPosition(firstAtom.position, wave.camera, canvas);

        wave.handlePointerDownCapture_({ clientX: clickEvent.layerX, clientY: clickEvent.layerY });
        wave.handlePointerUpCapture_({ clientX: clickEvent.layerX, clientY: clickEvent.layerY });

        expect(wave.isDraggingAtom_).toBe(false);
        expect(wave.selectedMesh_).toBe(firstAtom);
    });

    test("Selection is dropped on rebuild once the atom no longer exists", () => {
        const wave = getWaveInstance({});
        wave.enableEditMode(true);

        const [firstAtom] = wave.collectSelectableAtoms();
        wave.setSelectedAtomMesh(firstAtom);

        wave.reselectAtomByIndex(999);

        expect(wave.selectedMesh_).toBeNull();
        expect(wave.transformControls_.object).toBeUndefined();
    });

    test("no structure-modified event without a transform delta", () => {
        let callbackFired = false;
        const wave = getWaveInstance({
            onStructureModified: () => {
                callbackFired = true;
            },
        });
        wave.enableEditMode(true);

        const [firstAtom] = wave.collectSelectableAtoms();
        wave.setSelectedAtomMesh(firstAtom);

        // Simulate grabbing a gizmo handle and releasing it without any net movement.
        wave.transformControls_.dispatchEvent({ type: "dragging-changed", value: true });
        wave.transformControls_.dispatchEvent({ type: "mouseUp" });

        expect(callbackFired).toBe(false);
    });

    test("structure-modified event still fires when the gizmo actually moved the atom", () => {
        let callbackFired = false;
        const wave = getWaveInstance({
            onStructureModified: () => {
                callbackFired = true;
            },
        });
        wave.enableEditMode(true);

        const [firstAtom] = wave.collectSelectableAtoms();
        wave.setSelectedAtomMesh(firstAtom);

        wave.transformControls_.dispatchEvent({ type: "dragging-changed", value: true });
        firstAtom.position.x += 1;
        wave.transformControls_.dispatchEvent({ type: "mouseUp" });

        expect(callbackFired).toBe(true);
    });

    test("Escape mid-drag reverts the atom and commits nothing", () => {
        let callbackFired = false;
        const wave = getWaveInstance({
            onStructureModified: () => {
                callbackFired = true;
            },
        });
        wave.enableEditMode(true);

        const canvas = wave.renderer.domElement;
        canvas.getBoundingClientRect = () => ({
            left: 0,
            top: 0,
            width: canvas.width,
            height: canvas.height,
        });

        const [firstAtom] = wave.collectSelectableAtoms();
        const startEvent = getEventObjectBy3DPosition(firstAtom.position, wave.camera, canvas);
        const startPosition = firstAtom.position.clone();

        wave.handlePointerDownCapture_({ clientX: startEvent.layerX, clientY: startEvent.layerY });
        wave.handlePointerMoveCapture_({
            clientX: startEvent.layerX + 40,
            clientY: startEvent.layerY,
        });
        expect(wave.isDraggingAtom_).toBe(true);
        wave.handlePointerMoveCapture_({
            clientX: startEvent.layerX + 80,
            clientY: startEvent.layerY,
        });
        expect(firstAtom.position.equals(startPosition)).toBe(false);

        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

        expect(firstAtom.position.equals(startPosition)).toBe(true);
        expect(wave.isDraggingAtom_).toBe(false);
        expect(wave.pendingDragAtom_).toBeNull();
        expect(callbackFired).toBe(false);
    });

    test("Escape with no drag in progress deselects the current atom", () => {
        let selectedIndices = "unset";
        const wave = getWaveInstance({
            onSelectionChanged: (indices) => {
                selectedIndices = indices;
            },
        });
        wave.enableEditMode(true);

        const [firstAtom] = wave.collectSelectableAtoms();
        wave.setSelectedAtomMesh(firstAtom);

        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

        expect(wave.selectedMesh_).toBeNull();
        expect(selectedIndices).toEqual([]);
    });

    test("A right-click does not start a pending drag or select an atom", () => {
        const wave = getWaveInstance({});
        wave.enableEditMode(true);

        const canvas = wave.renderer.domElement;
        canvas.getBoundingClientRect = () => ({
            left: 0,
            top: 0,
            width: canvas.width,
            height: canvas.height,
        });

        const [firstAtom] = wave.collectSelectableAtoms();
        const clickEvent = getEventObjectBy3DPosition(firstAtom.position, wave.camera, canvas);

        wave.handlePointerDownCapture_({
            clientX: clickEvent.layerX,
            clientY: clickEvent.layerY,
            button: 2,
        });
        expect(wave.pendingDragAtom_).toBeNull();

        wave.handlePointerUpCapture_({
            clientX: clickEvent.layerX,
            clientY: clickEvent.layerY,
            button: 2,
        });
        expect(wave.selectedMesh_).toBeNull();
    });

    test("Ending a drag restores orbit controls to their pre-drag state, not unconditionally true", () => {
        const wave = getWaveInstance({});
        wave.enableEditMode(true);
        wave.orbitControls.enabled = false; // already off before the drag starts, e.g. some other UI disabled it

        const canvas = wave.renderer.domElement;
        canvas.getBoundingClientRect = () => ({
            left: 0,
            top: 0,
            width: canvas.width,
            height: canvas.height,
        });

        const [firstAtom] = wave.collectSelectableAtoms();
        const startEvent = getEventObjectBy3DPosition(firstAtom.position, wave.camera, canvas);

        wave.handlePointerDownCapture_({ clientX: startEvent.layerX, clientY: startEvent.layerY });
        wave.handlePointerMoveCapture_({
            clientX: startEvent.layerX + 40,
            clientY: startEvent.layerY,
        });
        expect(wave.orbitControls.enabled).toBe(false); // disabled during the drag either way
        wave.handlePointerUpCapture_({
            clientX: startEvent.layerX + 40,
            clientY: startEvent.layerY,
        });

        expect(wave.orbitControls.enabled).toBe(false);
    });

    test("Selection persists across an edit-mode disable/re-enable cycle", () => {
        const wave = getWaveInstance({});
        wave.enableEditMode(true);

        const [firstAtom] = wave.collectSelectableAtoms();
        wave.setSelectedAtomMesh(firstAtom);

        wave.enableEditMode(false);
        expect(wave.selectedMesh_).toBeNull();

        wave.enableEditMode(true);
        expect(wave.selectedMesh_).not.toBeNull();
        expect(wave.selectedMesh_.userData.atomicIndex).toBe(firstAtom.userData.atomicIndex);
    });

    test("An explicit deselect (not a mode toggle) is not restored on re-enabling edit mode", () => {
        const wave = getWaveInstance({});
        wave.enableEditMode(true);

        const [firstAtom] = wave.collectSelectableAtoms();
        wave.setSelectedAtomMesh(firstAtom);
        wave.clearSelectedAtom();

        wave.enableEditMode(false);
        wave.enableEditMode(true);

        expect(wave.selectedMesh_).toBeNull();
    });

    test("Hovering an atom shows the hover highlight and a move cursor; moving off hides it", () => {
        const wave = getWaveInstance({});
        wave.enableEditMode(true);

        const canvas = wave.renderer.domElement;
        canvas.getBoundingClientRect = () => ({
            left: 0,
            top: 0,
            width: canvas.width,
            height: canvas.height,
        });

        const [firstAtom] = wave.collectSelectableAtoms();
        const overAtom = getEventObjectBy3DPosition(firstAtom.position, wave.camera, canvas);

        wave.handlePointerMoveCapture_({ clientX: overAtom.layerX, clientY: overAtom.layerY });
        expect(wave.hoveredMesh_).toBe(firstAtom);
        expect(wave.hoverHighlightMesh_.visible).toBe(true);
        expect(canvas.style.cursor).toBe("move");

        wave.handlePointerMoveCapture_({ clientX: -9999, clientY: -9999 });
        expect(wave.hoveredMesh_).toBeNull();
        expect(wave.hoverHighlightMesh_.visible).toBe(false);
        expect(canvas.style.cursor).toBe("");
    });

    describe("Multi-select (D-4)", () => {
        test("Shift+click adds an atom to the selection", () => {
            const wave = getWaveInstance({});
            wave.enableEditMode(true);
            stubCanvasRect(wave);

            const [firstAtom, secondAtom] = wave.collectSelectableAtoms();
            simulateClick(wave, firstAtom);
            expect(wave.selectedMeshes_).toEqual([firstAtom]);

            const coords = projectMeshToScreen(wave, secondAtom);
            wave.handlePointerDownCapture_({
                clientX: coords.x,
                clientY: coords.y,
                shiftKey: true,
            });
            wave.handlePointerUpCapture_({ clientX: coords.x, clientY: coords.y, shiftKey: true });

            expect(wave.selectedMeshes_).toEqual([firstAtom, secondAtom]);
        });

        test("Ctrl/Cmd+click toggles an atom out of the selection", () => {
            const wave = getWaveInstance({});
            wave.enableEditMode(true);
            stubCanvasRect(wave);

            const [firstAtom, secondAtom] = wave.collectSelectableAtoms();
            wave.setSelectedAtomMeshes([firstAtom, secondAtom]);

            const coords = projectMeshToScreen(wave, secondAtom);
            wave.handlePointerDownCapture_({ clientX: coords.x, clientY: coords.y, ctrlKey: true });
            wave.handlePointerUpCapture_({ clientX: coords.x, clientY: coords.y, ctrlKey: true });

            expect(wave.selectedMeshes_).toEqual([firstAtom]);
        });

        test("Shift/Ctrl+click on empty space leaves the current selection alone", () => {
            const wave = getWaveInstance({});
            wave.enableEditMode(true);
            stubCanvasRect(wave);

            const [firstAtom] = wave.collectSelectableAtoms();
            wave.setSelectedAtomMeshes([firstAtom]);

            wave.handlePointerDownCapture_({ clientX: -9999, clientY: -9999, shiftKey: true });
            wave.handlePointerUpCapture_({ clientX: -9999, clientY: -9999, shiftKey: true });

            expect(wave.selectedMeshes_).toEqual([firstAtom]);
        });

        test("Marquee-select on empty space selects every atom within the rectangle", () => {
            const wave = getWaveInstance({});
            wave.enableEditMode(true);
            stubCanvasRect(wave);

            const atoms = wave.collectSelectableAtoms();
            const screenPoints = atoms.map((atom) => projectMeshToScreen(wave, atom));
            const margin = 60;
            const rectStart = {
                x: Math.min(...screenPoints.map((p) => p.x)) - margin,
                y: Math.min(...screenPoints.map((p) => p.y)) - margin,
            };
            const rectEnd = {
                x: Math.max(...screenPoints.map((p) => p.x)) + margin,
                y: Math.max(...screenPoints.map((p) => p.y)) + margin,
            };

            simulateMarqueeSelect(wave, rectStart, rectEnd);

            expect(wave.selectedMeshes_).toEqual(expect.arrayContaining(atoms));
            expect(wave.selectedMeshes_.length).toBe(atoms.length);
        });

        test("Marquee-select with Shift adds to the existing selection instead of replacing it", () => {
            const wave = getWaveInstance({});
            wave.enableEditMode(true);
            stubCanvasRect(wave);

            const [firstAtom, secondAtom] = wave.collectSelectableAtoms();
            // Select an atom that is NOT inside the upcoming marquee rectangle.
            wave.setSelectedAtomMeshes([firstAtom]);

            const secondScreen = projectMeshToScreen(wave, secondAtom);
            simulateMarqueeSelect(
                wave,
                { x: secondScreen.x - 40, y: secondScreen.y - 40 },
                { x: secondScreen.x + 40, y: secondScreen.y + 40 },
                { shiftKey: true },
            );

            expect(wave.selectedMeshes_).toEqual(expect.arrayContaining([firstAtom, secondAtom]));
            expect(wave.selectedMeshes_.length).toBe(2);
        });

        test("A marquee drag that never crosses the threshold behaves as a plain click on empty space", () => {
            const wave = getWaveInstance({});
            wave.enableEditMode(true);
            stubCanvasRect(wave);

            const [firstAtom] = wave.collectSelectableAtoms();
            wave.setSelectedAtomMeshes([firstAtom]);

            simulateMarqueeSelect(wave, { x: -9999, y: -9999 }, { x: -9998, y: -9999 });

            expect(wave.selectedMeshes_).toEqual([]);
        });

        test("Edit mode disables the left orbit button and moves rotation to the right button (D-4)", () => {
            const wave = getWaveInstance({});
            const defaultLeft = wave.orbitControls.mouseButtons.LEFT;

            wave.enableEditMode(true);
            expect(wave.orbitControls.mouseButtons.LEFT).toBeFalsy();
            expect(wave.orbitControls.mouseButtons.RIGHT).toBe(THREE.MOUSE.ROTATE);

            wave.enableEditMode(false);
            expect(wave.orbitControls.mouseButtons.LEFT).toBe(defaultLeft);
        });

        test("Dragging one atom of a multi-selection moves the whole group together, as a single commit", () => {
            const { wave, structureModifiedCalls } = getWaveWithRecordedCallbacks();
            wave.enableEditMode(true);
            stubCanvasRect(wave);

            const [firstAtom, secondAtom] = wave.collectSelectableAtoms();
            const secondStart = secondAtom.position.clone();
            wave.setSelectedAtomMeshes([firstAtom, secondAtom]);

            const { startPosition, endPosition } = simulateAtomDrag(wave, firstAtom, 40, 30, {
                assertIntermediateState: false,
            });
            const firstDelta = endPosition.clone().sub(startPosition);

            expect(
                secondAtom.position.clone().sub(secondStart).distanceTo(firstDelta),
            ).toBeLessThan(1e-6);
            expect(structureModifiedCalls.length).toBe(1);
        });

        test("Group drag via the gizmo pivot moves every selected atom and commits once", () => {
            const { wave, structureModifiedCalls } = getWaveWithRecordedCallbacks();
            wave.enableEditMode(true);

            const [firstAtom, secondAtom] = wave.collectSelectableAtoms();
            const firstStart = firstAtom.position.clone();
            const secondStart = secondAtom.position.clone();
            wave.setSelectedAtomMeshes([firstAtom, secondAtom]);

            expect(wave.transformControls_.object).toBe(wave.selectionPivot_);

            // TransformControls' own `dragging` property has a setter (see defineProperty in
            // its source) that auto-dispatches both "dragging-changed" and "change" - no need to
            // dispatch "dragging-changed" separately. Its real pointerUp() dispatches "mouseUp"
            // BEFORE setting dragging = false, so transformDragStartPosition_ (reset by this
            // mixin's "dragging-changed" listener on the false transition) is still valid when
            // the mouseUp handler reads it; this order must be preserved here too.
            wave.transformControls_.dragging = true;
            wave.selectionPivot_.position.x += 1;
            wave.transformControls_.dispatchEvent({ type: "change" });
            wave.transformControls_.dispatchEvent({ type: "mouseUp" });
            wave.transformControls_.dragging = false;

            expect(firstAtom.position.x - firstStart.x).toBeCloseTo(1, 6);
            expect(secondAtom.position.x - secondStart.x).toBeCloseTo(1, 6);
            expect(structureModifiedCalls.length).toBe(1);
            // rebuildScene() (wave.js) replaces every atom mesh - the commit must leave the
            // FULL group selected, not just the last-selected atom, so a second group action
            // (e.g. another drag) is still possible immediately after.
            expect(wave.selectedMeshes_.length).toBe(2);
            expect(wave.selectedMeshes_.map((mesh) => mesh.userData.atomicIndex).sort()).toEqual([
                0, 1,
            ]);
        });

        test("A multi-selection survives a rebuild triggered independently of the mixin's own commit (regression: host round-trip via onStructureModified must not collapse it to one atom)", () => {
            // A real host (ThreeDEditor.jsx's handleStructureModified -> _applyMaterialToViewer)
            // reacts to onStructureModified by calling setStructure()+rebuildScene() AGAIN, on
            // top of the rebuild the mixin's own commit already performed. rebuildScene() itself
            // (wave.js) must be multi-select-aware for this second, externally-triggered rebuild
            // to preserve the group too - simulate that second round-trip directly.
            const wave = getWaveInstance({});
            wave.enableEditMode(true);

            const [firstAtom, secondAtom] = wave.collectSelectableAtoms();
            wave.setSelectedAtomMeshes([firstAtom, secondAtom]);

            wave.setStructure(wave.structure);
            wave.rebuildScene();

            expect(wave.selectedMeshes_.length).toBe(2);
            expect(wave.selectedMeshes_.map((mesh) => mesh.userData.atomicIndex).sort()).toEqual([
                0, 1,
            ]);
            expect(wave.transformControls_.object).toBe(wave.selectionPivot_);
        });

        test("Escape during a group drag reverts every atom and commits nothing", () => {
            const { wave, structureModifiedCalls } = getWaveWithRecordedCallbacks();
            wave.enableEditMode(true);
            stubCanvasRect(wave);

            const [firstAtom, secondAtom] = wave.collectSelectableAtoms();
            const firstStart = firstAtom.position.clone();
            const secondStart = secondAtom.position.clone();
            wave.setSelectedAtomMeshes([firstAtom, secondAtom]);

            const start = projectMeshToScreen(wave, firstAtom);
            wave.handlePointerDownCapture_({ clientX: start.x, clientY: start.y });
            wave.handlePointerMoveCapture_({ clientX: start.x + 40, clientY: start.y });
            expect(wave.isDraggingGroup_).toBe(true);
            wave.handlePointerMoveCapture_({ clientX: start.x + 80, clientY: start.y + 20 });

            document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

            expect(firstAtom.position.equals(firstStart)).toBe(true);
            expect(secondAtom.position.equals(secondStart)).toBe(true);
            expect(structureModifiedCalls.length).toBe(0);
        });

        test("Removing a multi-selection removes every selected atom as a single commit", () => {
            const { wave, structureModifiedCalls } = getWaveWithRecordedCallbacks();
            wave.enableEditMode(true);

            const atoms = wave.collectSelectableAtoms();
            wave.setSelectedAtomMeshes(atoms);
            const initialCount = atoms.length;

            wave.removeSelectedAtom();

            expect(wave.collectSelectableAtoms().length).toBe(initialCount - atoms.length);
            expect(structureModifiedCalls.length).toBe(1);
            expect(wave.selectedMeshes_).toEqual([]);
        });

        test.each([
            ["as one multi-selection", [[1, 2, 3]]],
            ["one atom at a time", [[1], [1], [1]]],
        ])(
            "An atom added after removing atoms %s does not inherit a removed atom's starting magnetization",
            (_removal, selectedIndicesPerRemoval) => {
                const wave = getFeOWaveInstance({});
                wave.enableEditMode(true);

                // FeO: Fe +0.5, Fe -0.5, O, O. The added O takes the next free id, the removed Fe's.
                selectedIndicesPerRemoval.forEach((selectedIndices) => {
                    const atoms = wave.collectSelectableAtoms();
                    wave.setSelectedAtomMeshes(selectedIndices.map((index) => atoms[index]));
                    wave.removeSelectedAtom();
                });
                wave.addAtom("O", [0, 0, 0]);

                expect(wave.structure.getBasis().startingMagnetizationArray).toEqual([0.5, 0]);
            },
        );

        test("A multi-selection survives an edit-mode disable/re-enable cycle (R12, extended to groups)", () => {
            const wave = getWaveInstance({});
            wave.enableEditMode(true);

            const atoms = wave.collectSelectableAtoms();
            wave.setSelectedAtomMeshes(atoms);

            wave.enableEditMode(false);
            expect(wave.selectedMeshes_).toEqual([]);

            wave.enableEditMode(true);
            expect(wave.selectedMeshes_.length).toBe(atoms.length);
            expect(wave.selectedMeshes_.map((mesh) => mesh.userData.atomicIndex).sort()).toEqual(
                atoms.map((mesh) => mesh.userData.atomicIndex).sort(),
            );
        });
    });

    describe("Parity: group rotate, clone, camera focus (old-editor parity)", () => {
        test("Rotating the group pivot via the gizmo rotates every selected atom rigidly about the shared centroid, as a single commit", () => {
            const { wave, structureModifiedCalls } = getWaveWithRecordedCallbacks();
            wave.enableEditMode(true);

            const [firstAtom, secondAtom] = wave.collectSelectableAtoms();
            wave.setSelectedAtomMeshes([firstAtom, secondAtom]);
            wave.setTransformMode("rotate");

            const centroid = firstAtom.position.clone().add(secondAtom.position).divideScalar(2);
            const firstRadius = firstAtom.position.distanceTo(centroid);
            const secondRadius = secondAtom.position.distanceTo(centroid);
            const firstOffset = firstAtom.position.clone().sub(centroid);
            const quaternion = new THREE.Quaternion().setFromAxisAngle(
                new THREE.Vector3(0, 0, 1),
                Math.PI / 2,
            );

            // Same real event order as the group-translate test above: dragging=true auto-fires
            // dragging-changed+change (snapshotting transformDragStartPosition_/Quaternion_),
            // the pivot's quaternion is then set directly (as TransformControls itself would),
            // a manual "change" propagates it to the atoms, "mouseUp" commits while the start
            // snapshot is still valid, and only then dragging=false.
            wave.transformControls_.dragging = true;
            wave.selectionPivot_.quaternion.copy(quaternion);
            wave.transformControls_.dispatchEvent({ type: "change" });
            wave.transformControls_.dispatchEvent({ type: "mouseUp" });
            wave.transformControls_.dragging = false;

            const expectedFirst = centroid
                .clone()
                .add(firstOffset.clone().applyQuaternion(quaternion));
            expect(firstAtom.position.distanceTo(expectedFirst)).toBeLessThan(1e-6);
            // Rigid rotation about the shared centroid: each atom's distance from it is preserved.
            expect(firstAtom.position.distanceTo(centroid)).toBeCloseTo(firstRadius, 6);
            expect(secondAtom.position.distanceTo(centroid)).toBeCloseTo(secondRadius, 6);
            expect(structureModifiedCalls.length).toBe(1);
            // The pivot's rotation is relative to each drag, not cumulative - reset to identity
            // after commit so the next attach/drag starts clean.
            expect(wave.selectionPivot_.quaternion.angleTo(new THREE.Quaternion())).toBeLessThan(
                1e-9,
            );
            // rebuildScene() must leave the FULL group selected (not just one atom), or the
            // Rotate button would go right back to disabled and a second rotate would be
            // impossible.
            expect(wave.selectedMeshes_.length).toBe(2);
        });

        test("A second consecutive group rotate still works after a host round-trip rebuild (regression)", () => {
            const { wave, structureModifiedCalls } = getWaveWithRecordedCallbacks();
            wave.enableEditMode(true);

            const [firstAtom, secondAtom] = wave.collectSelectableAtoms();
            wave.setSelectedAtomMeshes([firstAtom, secondAtom]);
            wave.setTransformMode("rotate");

            const rotateOnce = () => {
                wave.transformControls_.dragging = true;
                wave.selectionPivot_.quaternion.setFromAxisAngle(
                    new THREE.Vector3(0, 0, 1),
                    Math.PI / 4,
                );
                wave.transformControls_.dispatchEvent({ type: "change" });
                wave.transformControls_.dispatchEvent({ type: "mouseUp" });
                wave.transformControls_.dragging = false;
            };

            rotateOnce();
            // Simulate the host's onStructureModified round-trip (ThreeDEditor.jsx's
            // handleStructureModified -> _applyMaterialToViewer), which independently calls
            // setStructure()+rebuildScene() again on top of the mixin's own commit.
            wave.setStructure(wave.structure);
            wave.rebuildScene();
            expect(wave.selectedMeshes_.length).toBe(2);
            expect(wave.transformControls_.object).toBe(wave.selectionPivot_);

            const beforeSecond = wave.collectSelectableAtoms().map((atom) => atom.position.clone());
            rotateOnce();
            const afterSecond = wave.collectSelectableAtoms().map((atom) => atom.position.clone());

            expect(structureModifiedCalls.length).toBe(2);
            expect(wave.selectedMeshes_.length).toBe(2);
            beforeSecond.forEach((position, index) => {
                expect(position.distanceTo(afterSecond[index])).toBeGreaterThan(1e-3);
            });
        });

        test("no structure-modified event from a zero-rotation gizmo click-release", () => {
            const { wave, structureModifiedCalls } = getWaveWithRecordedCallbacks();
            wave.enableEditMode(true);

            const atoms = wave.collectSelectableAtoms();
            wave.setSelectedAtomMeshes(atoms);
            wave.setTransformMode("rotate");

            wave.transformControls_.dragging = true;
            wave.transformControls_.dispatchEvent({ type: "mouseUp" });
            wave.transformControls_.dragging = false;

            expect(structureModifiedCalls.length).toBe(0);
        });

        test("Cloning a single selected atom adds one atom of the same element at an offset and selects the clone", () => {
            const { wave, structureModifiedCalls, selectionChangedCalls } =
                getWaveWithRecordedCallbacks();
            wave.enableEditMode(true);

            const [firstAtom] = wave.collectSelectableAtoms();
            wave.setSelectedAtomMeshes([firstAtom]);
            const initialCount = wave.collectSelectableAtoms().length;
            const sourcePosition = firstAtom.position.clone();

            wave.cloneSelectedAtoms();

            const atoms = wave.collectSelectableAtoms();
            expect(atoms.length).toBe(initialCount + 1);
            expect(structureModifiedCalls.length).toBe(1);

            const newAtom = atoms[atoms.length - 1];
            expect(newAtom.userData.atomicIndex).toBe(initialCount);
            expect(newAtom.position.distanceTo(sourcePosition)).toBeGreaterThan(0.01);
            // Selection moves to the clone, matching Add Atom's auto-select behavior.
            expect(wave.selectedMeshes_).toEqual([newAtom]);
            expect(selectionChangedCalls[selectionChangedCalls.length - 1]).toEqual([
                [initialCount],
            ]);

            const toSymbol = (element) => (typeof element === "string" ? element : element.value);
            const clonedElement = wave.structure.basis.elements[newAtom.userData.atomicIndex];
            const originalElement = wave.structure.basis.elements[firstAtom.userData.atomicIndex];
            expect(toSymbol(clonedElement)).toBe(toSymbol(originalElement));
        });

        test("Cloning a multi-atom selection adds one clone per atom, preserving relative offsets, as a single commit", () => {
            const { wave, structureModifiedCalls } = getWaveWithRecordedCallbacks();
            wave.enableEditMode(true);

            const atoms = wave.collectSelectableAtoms();
            wave.setSelectedAtomMeshes(atoms);
            const initialCount = atoms.length;
            const originalRelativeOffset = atoms[1].position.clone().sub(atoms[0].position);

            wave.cloneSelectedAtoms();

            const allAtoms = wave.collectSelectableAtoms();
            expect(allAtoms.length).toBe(initialCount * 2);
            expect(structureModifiedCalls.length).toBe(1);
            expect(wave.selectedMeshes_.length).toBe(initialCount);

            const clones = allAtoms.slice(initialCount);
            const clonedRelativeOffset = clones[1].position.clone().sub(clones[0].position);
            expect(clonedRelativeOffset.distanceTo(originalRelativeOffset)).toBeLessThan(1e-6);
        });

        test("Cloning with nothing selected is a no-op", () => {
            const { wave, structureModifiedCalls } = getWaveWithRecordedCallbacks();
            wave.enableEditMode(true);
            const initialCount = wave.collectSelectableAtoms().length;

            wave.cloneSelectedAtoms();

            expect(wave.collectSelectableAtoms().length).toBe(initialCount);
            expect(structureModifiedCalls.length).toBe(0);
        });

        test("Focusing the camera on a selection re-targets and re-distances without changing the viewing angle", () => {
            const wave = getWaveInstance({});
            wave.enableEditMode(true);
            // A distinctive, non-default position/target so a coincidental match with the
            // selection's centroid can't hide a bug.
            wave.camera.position.set(20, 5, 8);
            wave.orbitControls.target.set(1, 1, 1);
            wave.camera.lookAt(wave.orbitControls.target);
            const previousDirection = wave.camera.position
                .clone()
                .sub(wave.orbitControls.target)
                .normalize();

            const atoms = wave.collectSelectableAtoms();
            wave.setSelectedAtomMeshes(atoms);
            const expectedCenter = new THREE.Vector3();
            atoms.forEach((atom) => expectedCenter.add(atom.position));
            expectedCenter.divideScalar(atoms.length);

            wave.focusCameraOnSelection();

            expect(wave.orbitControls.target.distanceTo(expectedCenter)).toBeLessThan(1e-6);
            const newDirection = wave.camera.position
                .clone()
                .sub(wave.orbitControls.target)
                .normalize();
            expect(newDirection.distanceTo(previousDirection)).toBeLessThan(1e-6);
        });

        test("Focusing the camera with nothing selected is a no-op", () => {
            const wave = getWaveInstance({});
            wave.enableEditMode(true);
            const previousPosition = wave.camera.position.clone();
            const previousTarget = wave.orbitControls.target.clone();

            wave.focusCameraOnSelection();

            expect(wave.camera.position.equals(previousPosition)).toBe(true);
            expect(wave.orbitControls.target.equals(previousTarget)).toBe(true);
        });
    });

    describe("TB-persona review fixes (PR #204 round 1-2)", () => {
        test("The camera-focus hotkey is driven by settings.hotKeysConfig, not a hardcoded literal", () => {
            // Every other hotkey-advertising tooltip in ThreeDEditor.jsx derives its key from
            // settings.hotKeysConfig (the direct fix for D2 - a hardcoded tooltip that drifted
            // from the actual binding). "F" for camera-focus was wired the old, broken way: a
            // bare `event.key.toLowerCase() === "f"` literal with no config entry, so a future
            // rebind (or a collision with some other feature's key) would silently desync the
            // tooltip from the real binding again with nothing to catch it. This test exercises
            // the real keydown dispatch path (not a direct focusCameraOnSelection() call) so it
            // actually proves the configured key - not just "f" - is what triggers the focus.
            const wave = getWaveInstance({});
            wave.enableEditMode(true);
            const [firstAtom] = wave.collectSelectableAtoms();
            wave.setSelectedAtomMesh(firstAtom);

            const focusSpy = jest.spyOn(wave, "focusCameraOnSelection");
            document.dispatchEvent(
                new KeyboardEvent("keydown", {
                    key: settings.hotKeysConfig.focusCameraOnSelection,
                }),
            );

            expect(focusSpy).toHaveBeenCalledTimes(1);
        });

        test("Repetition-clone atoms are not selectable/draggable - editor picking is scoped to the base structure only (regression)", () => {
            // RepetitionMixin.repeatAtomsAtRepetitionCoordinates (repetition.js, unrelated to and
            // unchanged by this PR) names every repetition-clone group ATOM_GROUP_NAME too, same
            // as the one real base-structure group, and deliberately gives each clone atom an
            // atomicIndex offset out of the material's actual range. collectSelectableAtoms()
            // (renamed from collectAllAtoms, wave.js) used to walk every matching group, making
            // those clones real, clickable, draggable meshes in edit mode with an out-of-range
            // index: selecting one indexed material.basis.coordinates[] out of bounds (a blank
            // panel), and dragging one committed a spurious no-op history entry before visibly
            // snapping back on the next rebuild (its position is always re-derived from the
            // unchanged base atom, never actually stored). Fixed by scoping to the FIRST matching
            // group only - the same fix (and the same underlying invariant: the base group is
            // added before any clone) extractBasisFromScene already uses, per utils.js's own
            // documented traversal.
            const wave = getWaveInstance({
                repetitionsAlongLatticeVectorA: 3,
                repetitionsAlongLatticeVectorB: 2,
                repetitionsAlongLatticeVectorC: 1,
            });
            wave.enableEditMode(true);

            // getAtomGroups() (atoms.ts) is the measurement feature's own, deliberately
            // clone-inclusive collector (RepetitionMixin's clones are real, intentional targets
            // for measuring distances/angles to a periodic image) - it must stay unaffected.
            const allRenderedAtoms = wave.getAtomGroups();
            const selectableAtoms = wave.collectSelectableAtoms();

            expect(allRenderedAtoms.length).toBeGreaterThan(selectableAtoms.length);
            expect(selectableAtoms.length).toBe(2); // MATERIAL_CONFIG's base atom count
            selectableAtoms.forEach((atom) => {
                expect(atom.userData.atomicIndex).toBeLessThan(selectableAtoms.length);
            });
        });

        test("A scene rebuild that removes the currently selected atom notifies onSelectionChanged (regression: undo/redo desync)", () => {
            // ThreeDEditor.jsx's undo/redo calls wave.setStructure()+wave.rebuildScene()
            // directly, entirely independently of any explicit selection action -
            // reselectAtomsByIndices (called from inside rebuildScene(), wave.js) must itself
            // notify the host when this silently invalidates the current selection, or the
            // host's selection state is left pointing at an atomicIndex that no longer exists on
            // the wave side (a "phantom" selection: the coordinate panel shows a stale/blank
            // atom, and Delete/Clone/Focus stay enabled but silently no-op).
            const { wave, selectionChangedCalls } = getWaveWithRecordedCallbacks();
            wave.enableEditMode(true);

            const atoms = wave.collectSelectableAtoms();
            const lastIndex = atoms.length - 1;
            wave.setSelectedAtomMesh(atoms[lastIndex]);

            const materialWithoutLastAtom = wave.applyBasisDelta_((basis) => {
                basis.elements = basis.elements.filter((_element, index) => index !== lastIndex);
                basis.coordinates = basis.coordinates.filter(
                    (_coordinate, index) => index !== lastIndex,
                );
            });
            wave.setStructure(materialWithoutLastAtom);
            wave.rebuildScene();

            expect(wave.selectedMeshes_).toEqual([]);
            expect(selectionChangedCalls[selectionChangedCalls.length - 1]).toEqual([[]]);
        });

        test("A scene rebuild that does not affect the current selection does not fire a spurious onSelectionChanged", () => {
            const { wave, selectionChangedCalls } = getWaveWithRecordedCallbacks();
            wave.enableEditMode(true);
            const [firstAtom] = wave.collectSelectableAtoms();
            wave.setSelectedAtomMesh(firstAtom);

            wave.rebuildScene(); // e.g. triggered by an unrelated viewer-setting change

            expect(selectionChangedCalls.length).toBe(0);
        });

        test("Group direct-drag (not the gizmo) keeps the pivot tracking the live centroid instead of staying frozen at the pre-drag spot", () => {
            const wave = getWaveInstance({});
            wave.enableEditMode(true);
            stubCanvasRect(wave);

            const [firstAtom, secondAtom] = wave.collectSelectableAtoms();
            wave.setSelectedAtomMeshes([firstAtom, secondAtom]);
            const pivotStart = wave.selectionPivot_.position.clone();

            const start = projectMeshToScreen(wave, firstAtom);
            wave.handlePointerDownCapture_({ clientX: start.x, clientY: start.y });
            wave.handlePointerMoveCapture_({ clientX: start.x + 40, clientY: start.y });
            expect(wave.isDraggingGroup_).toBe(true);
            wave.handlePointerMoveCapture_({ clientX: start.x + 80, clientY: start.y + 20 });

            const expectedCentroid = firstAtom.position
                .clone()
                .add(secondAtom.position)
                .divideScalar(2);
            expect(wave.selectionPivot_.position.distanceTo(expectedCentroid)).toBeLessThan(1e-6);
            expect(wave.selectionPivot_.position.distanceTo(pivotStart)).toBeGreaterThan(0.01);

            wave.handlePointerUpCapture_({ clientX: start.x + 80, clientY: start.y + 20 });
        });

        test("Cloning the same atom twice in a row does not stack the clones at a coincident position (occupied-site guard, mirrors D22)", () => {
            const wave = getWaveInstance({});
            wave.enableEditMode(true);
            const [firstAtom] = wave.collectSelectableAtoms();

            wave.setSelectedAtomMeshes([firstAtom]);
            wave.cloneSelectedAtoms();
            const [firstClone] = wave.selectedMeshes_;

            wave.setSelectedAtomMeshes([firstAtom]);
            wave.cloneSelectedAtoms();
            const [secondClone] = wave.selectedMeshes_;

            expect(firstClone.position.distanceTo(secondClone.position)).toBeGreaterThan(0.4);
        });

        test("Escape during a single-atom GIZMO drag reverts the atom and commits nothing", () => {
            // Direct-body-drag Esc-cancel was already covered ("Escape mid-drag reverts the atom
            // and commits nothing", above) - but that path (isDraggingAtom_/pendingDragAtom_)
            // never engages for a gizmo-handle drag, which uses TransformControls' own dragging
            // flag instead. Before this fix, Esc during translate mode's default interaction -
            // grabbing the gizmo - silently did nothing: the drag continued, and the eventual
            // real mouseup committed a delta the user had tried to cancel.
            const { wave, structureModifiedCalls } = getWaveWithRecordedCallbacks();
            wave.enableEditMode(true);
            const [firstAtom] = wave.collectSelectableAtoms();
            wave.setSelectedAtomMesh(firstAtom);
            const startPosition = firstAtom.position.clone();

            wave.transformControls_.dragging = true;
            firstAtom.position.x += 1;
            wave.transformControls_.dispatchEvent({ type: "change" });
            expect(firstAtom.position.equals(startPosition)).toBe(false);

            document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

            expect(firstAtom.position.equals(startPosition)).toBe(true);
            expect(wave.transformControls_.dragging).toBe(false);
            expect(structureModifiedCalls.length).toBe(0);
        });

        test("Escape during a group gizmo TRANSLATE drag reverts every atom and the pivot, and commits nothing", () => {
            const { wave, structureModifiedCalls } = getWaveWithRecordedCallbacks();
            wave.enableEditMode(true);
            const [firstAtom, secondAtom] = wave.collectSelectableAtoms();
            wave.setSelectedAtomMeshes([firstAtom, secondAtom]);
            const firstStart = firstAtom.position.clone();
            const secondStart = secondAtom.position.clone();
            const pivotStart = wave.selectionPivot_.position.clone();

            wave.transformControls_.dragging = true;
            wave.selectionPivot_.position.x += 1;
            wave.transformControls_.dispatchEvent({ type: "change" });
            expect(firstAtom.position.equals(firstStart)).toBe(false);

            document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

            expect(firstAtom.position.equals(firstStart)).toBe(true);
            expect(secondAtom.position.equals(secondStart)).toBe(true);
            expect(wave.selectionPivot_.position.equals(pivotStart)).toBe(true);
            expect(wave.transformControls_.dragging).toBe(false);
            expect(structureModifiedCalls.length).toBe(0);
            // The group must still be fully selected and grabbable afterward - Esc shouldn't
            // leave the gizmo half-detached.
            expect(wave.selectedMeshes_.length).toBe(2);
            expect(wave.transformControls_.object).toBe(wave.selectionPivot_);
        });

        test("Escape during a group gizmo ROTATE drag reverts every atom's rotation and commits nothing", () => {
            const { wave, structureModifiedCalls } = getWaveWithRecordedCallbacks();
            wave.enableEditMode(true);
            const [firstAtom, secondAtom] = wave.collectSelectableAtoms();
            wave.setSelectedAtomMeshes([firstAtom, secondAtom]);
            wave.setTransformMode("rotate");
            const firstStart = firstAtom.position.clone();
            const secondStart = secondAtom.position.clone();

            wave.transformControls_.dragging = true;
            wave.selectionPivot_.quaternion.setFromAxisAngle(
                new THREE.Vector3(0, 0, 1),
                Math.PI / 3,
            );
            wave.transformControls_.dispatchEvent({ type: "change" });
            expect(firstAtom.position.equals(firstStart)).toBe(false);

            document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

            expect(firstAtom.position.distanceTo(firstStart)).toBeLessThan(1e-6);
            expect(secondAtom.position.distanceTo(secondStart)).toBeLessThan(1e-6);
            expect(wave.selectionPivot_.quaternion.angleTo(new THREE.Quaternion())).toBeLessThan(
                1e-9,
            );
            expect(wave.transformControls_.dragging).toBe(false);
            expect(structureModifiedCalls.length).toBe(0);
        });
    });

    describe("onEditCommit source tagging (spec §6.2)", () => {
        // onStructureModified(material, source) is the mixin-level half of spec §6.2's
        // onEditCommit(material, {source}) contract - ThreeDEditor.jsx forwards this second
        // argument as-is. Verifying it at this layer (rather than only end-to-end through the
        // component) pins down exactly which mixin method is responsible for which source value,
        // independent of the React-side plumbing.
        test("A direct body-drag commits with source 'drag'", () => {
            const { wave, structureModifiedCalls } = getWaveWithRecordedCallbacks();
            wave.enableEditMode(true);
            stubCanvasRect(wave);

            const [firstAtom] = wave.collectSelectableAtoms();
            simulateAtomDrag(wave, firstAtom, 40, 30);

            expect(structureModifiedCalls.length).toBe(1);
            const [, source] = structureModifiedCalls[0];
            expect(source).toBe("drag");
        });

        test("A group gizmo commit (translate or rotate) commits with source 'gizmo'", () => {
            const { wave, structureModifiedCalls } = getWaveWithRecordedCallbacks();
            wave.enableEditMode(true);

            const atoms = wave.collectSelectableAtoms();
            wave.setSelectedAtomMeshes(atoms);

            wave.transformControls_.dragging = true;
            wave.selectionPivot_.position.x += 1;
            wave.transformControls_.dispatchEvent({ type: "change" });
            wave.transformControls_.dispatchEvent({ type: "mouseUp" });
            wave.transformControls_.dragging = false;

            expect(structureModifiedCalls.length).toBe(1);
            const [, source] = structureModifiedCalls[0];
            expect(source).toBe("gizmo");
        });

        test("A single-atom gizmo commit also commits with source 'gizmo'", () => {
            const { wave, structureModifiedCalls } = getWaveWithRecordedCallbacks();
            wave.enableEditMode(true);
            const [firstAtom] = wave.collectSelectableAtoms();
            wave.setSelectedAtomMesh(firstAtom);

            wave.transformControls_.dragging = true;
            firstAtom.position.x += 1;
            wave.transformControls_.dispatchEvent({ type: "change" });
            wave.transformControls_.dispatchEvent({ type: "mouseUp" });
            wave.transformControls_.dragging = false;

            expect(structureModifiedCalls.length).toBe(1);
            const [, source] = structureModifiedCalls[0];
            expect(source).toBe("gizmo");
        });

        test("Add Atom commits with source 'add'", () => {
            const { wave, structureModifiedCalls } = getWaveWithRecordedCallbacks();
            wave.addAtom("Si", [0, 0, 0]);

            expect(structureModifiedCalls.length).toBe(1);
            const [, source] = structureModifiedCalls[0];
            expect(source).toBe("add");
        });

        test("Removing a single atom commits with source 'remove'", () => {
            const { wave, structureModifiedCalls } = getWaveWithRecordedCallbacks();
            const [firstAtom] = wave.collectSelectableAtoms();
            wave.selectedMesh_ = firstAtom;
            wave.removeSelectedAtom();

            expect(structureModifiedCalls.length).toBe(1);
            const [, source] = structureModifiedCalls[0];
            expect(source).toBe("remove");
        });

        test("Removing a multi-selection commits with source 'remove'", () => {
            const { wave, structureModifiedCalls } = getWaveWithRecordedCallbacks();
            wave.enableEditMode(true);
            const atoms = wave.collectSelectableAtoms();
            wave.setSelectedAtomMeshes(atoms);
            wave.removeSelectedAtom();

            expect(structureModifiedCalls.length).toBe(1);
            const [, source] = structureModifiedCalls[0];
            expect(source).toBe("remove");
        });

        test("Cloning commits with source 'clone'", () => {
            const { wave, structureModifiedCalls } = getWaveWithRecordedCallbacks();
            const [firstAtom] = wave.collectSelectableAtoms();
            wave.setSelectedAtomMeshes([firstAtom]);
            wave.cloneSelectedAtoms();

            expect(structureModifiedCalls.length).toBe(1);
            const [, source] = structureModifiedCalls[0];
            expect(source).toBe("clone");
        });
    });

    describe("Basis unit-conversion scoped to touched atoms (spec §5.2)", () => {
        // MATERIAL_CONFIG's basis is stored in crystal (fractional) units. Before this fix,
        // commitMovedAtoms_/addAtom/cloneSelectedAtoms flipped the WHOLE basis to Cartesian and
        // back via basis.toCartesian()/toCrystal() just to place one touched atom's coordinate -
        // toCartesian()/toCrystal() round-trip EVERY atom (mapArrayInPlace), not just the
        // touched one. These tests pin down that only the touched atom's coordinate is ever
        // converted now, independent of Basis's own serialize-time rounding (Cell.roundPrecision)
        // incidentally masking the difference for well-conditioned lattices.
        //
        // The spy targets ONLY the ephemeral basis instance applyBasisDelta_ builds for this one
        // commit (via an instance-level jest.spyOn, not the shared class prototype) - the wave
        // also legitimately calls toCartesian/toCrystal elsewhere unrelated to this fix
        // (setStructure's own always-Cartesian rendering basis; Made's repeat() tool computing
        // periodic-image positions during rebuildScene), and a prototype-wide spy would wrongly
        // flag those too.
        const toValue = (coordinate) => (Array.isArray(coordinate) ? coordinate : coordinate.value);

        function spyOnDeltaBasisConversions(wave) {
            const originalApplyBasisDelta = wave.applyBasisDelta_.bind(wave);
            const spies = {};
            jest.spyOn(wave, "applyBasisDelta_").mockImplementation((mutateBasis) =>
                originalApplyBasisDelta((basis) => {
                    spies.toCartesian = jest.spyOn(basis, "toCartesian");
                    spies.toCrystal = jest.spyOn(basis, "toCrystal");
                    return mutateBasis(basis);
                }),
            );
            return spies;
        }

        afterEach(() => {
            jest.restoreAllMocks();
        });

        test("Dragging an atom does not round-trip the touched basis through toCartesian/toCrystal", () => {
            const wave = getWaveInstance({});
            wave.enableEditMode(true);
            stubCanvasRect(wave);
            const spies = spyOnDeltaBasisConversions(wave);

            const [firstAtom] = wave.collectSelectableAtoms();
            simulateAtomDrag(wave, firstAtom, 40, 30);

            expect(spies.toCartesian).not.toHaveBeenCalled();
            expect(spies.toCrystal).not.toHaveBeenCalled();
        });

        test("Adding an atom does not round-trip the touched basis through toCartesian/toCrystal", () => {
            const wave = getWaveInstance({});
            const spies = spyOnDeltaBasisConversions(wave);

            wave.addAtom("Si", [0, 0, 0]);

            expect(spies.toCartesian).not.toHaveBeenCalled();
            expect(spies.toCrystal).not.toHaveBeenCalled();
        });

        test("Cloning atoms does not round-trip the touched basis through toCartesian/toCrystal", () => {
            const wave = getWaveInstance({});
            const [firstAtom] = wave.collectSelectableAtoms();
            wave.setSelectedAtomMeshes([firstAtom]);
            const spies = spyOnDeltaBasisConversions(wave);

            wave.cloneSelectedAtoms();

            expect(spies.toCartesian).not.toHaveBeenCalled();
            expect(spies.toCrystal).not.toHaveBeenCalled();
        });

        test("Dragging one atom leaves every other atom's crystal coordinate exactly unchanged", () => {
            const { wave, structureModifiedCalls } = getWaveWithRecordedCallbacks();
            wave.enableEditMode(true);
            stubCanvasRect(wave);

            const [firstAtom, secondAtom] = wave.collectSelectableAtoms();
            const untouchedIndex = secondAtom.userData.atomicIndex;
            const untouchedBefore = toValue(wave.structure.basis.coordinates[untouchedIndex]);

            simulateAtomDrag(wave, firstAtom, 40, 30);

            const [committedMaterial] = structureModifiedCalls[structureModifiedCalls.length - 1];
            const untouchedAfter = toValue(committedMaterial.basis.coordinates[untouchedIndex]);
            expect(untouchedAfter).toEqual(untouchedBefore);
        });

        test("A dragged atom's committed crystal coordinate converts back to its exact dragged Cartesian position", () => {
            const { wave, structureModifiedCalls } = getWaveWithRecordedCallbacks();
            wave.enableEditMode(true);
            stubCanvasRect(wave);

            const [firstAtom] = wave.collectSelectableAtoms();
            const targetIndex = firstAtom.userData.atomicIndex;

            const { endPosition } = simulateAtomDrag(wave, firstAtom, 40, 30);

            const [committedMaterial] = structureModifiedCalls[structureModifiedCalls.length - 1];
            const committedCrystal = toValue(committedMaterial.basis.coordinates[targetIndex]);
            const roundTripped = committedMaterial
                .getBasis()
                .cell.convertPointToCartesian(committedCrystal);

            ["x", "y", "z"].forEach((axis, i) => {
                expect(roundTripped[i]).toBeCloseTo(endPosition[axis], 6);
            });
        });

        test("Cloning an atom leaves the source atom's crystal coordinate exactly unchanged", () => {
            const { wave, structureModifiedCalls } = getWaveWithRecordedCallbacks();
            wave.enableEditMode(true);

            const [firstAtom] = wave.collectSelectableAtoms();
            const sourceIndex = firstAtom.userData.atomicIndex;
            const sourceBefore = toValue(wave.structure.basis.coordinates[sourceIndex]);
            wave.setSelectedAtomMeshes([firstAtom]);

            wave.cloneSelectedAtoms();

            const [committedMaterial] = structureModifiedCalls[structureModifiedCalls.length - 1];
            const sourceAfter = toValue(committedMaterial.basis.coordinates[sourceIndex]);
            expect(sourceAfter).toEqual(sourceBefore);
        });
    });
});
