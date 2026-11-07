import expect from "expect";

import { getFeOWaveInstance, getWaveInstance } from "../enums";
import { takeSnapshotAndAssertEqualityAsync } from "../utils";

test("wave", async () => {
    const wave = getWaveInstance();
    return takeSnapshotAndAssertEqualityAsync(wave.renderer.getContext(), "wave");
});

test("atomRadiiScale", async () => {
    const wave = getWaveInstance();
    wave.updateSettings({ atomRadiiScale: 0.5 });
    wave.rebuildScene();
    return takeSnapshotAndAssertEqualityAsync(wave.renderer.getContext(), "atomRadiiScale");
});

test("atomRepetitions", async () => {
    const wave = getWaveInstance();
    wave.updateSettings({
        repetitionsAlongLatticeVectorA: 2,
        repetitionsAlongLatticeVectorB: 2,
        repetitionsAlongLatticeVectorC: 2,
    });
    wave.rebuildScene();
    return takeSnapshotAndAssertEqualityAsync(wave.renderer.getContext(), "atomRepetitions");
});

test("spinColorsOfAtomsByStartingMagnetization", async () => {
    const wave = getFeOWaveInstance();
    // zoom-out to get full view of the cell
    wave.toggleOrbitControls();
    wave.renderer.domElement.dispatchEvent(new WheelEvent("wheel", { deltaY: 1 }));
    wave.renderer.domElement.dispatchEvent(new WheelEvent("wheel", { deltaY: 1 }));
    wave.renderer.domElement.dispatchEvent(new WheelEvent("wheel", { deltaY: 1 }));
    wave.renderer.domElement.dispatchEvent(new WheelEvent("wheel", { deltaY: 1 }));
    return takeSnapshotAndAssertEqualityAsync(
        wave.renderer.getContext(),
        "colorsOfAtomsWithLabels",
    );
});

test("dispose() disconnects the resize observer and releases the renderer (D15)", () => {
    const wave = getWaveInstance();
    const disconnectSpy = jest.spyOn(wave._resizeObserver, "disconnect");
    const rendererDisposeSpy = jest.spyOn(wave.renderer, "dispose");

    wave.dispose();

    expect(disconnectSpy).toHaveBeenCalledTimes(1);
    expect(rendererDisposeSpy).toHaveBeenCalledTimes(1);
    expect(wave._resizeObserver).toBeNull();
});
