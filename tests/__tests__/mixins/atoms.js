import { PERIODIC_TABLE } from "@mat3ra/periodic-table";
import expect from "expect";

import { ApplyGlow } from "../../../src/mixins/utils";
import { getFeOWaveInstance, getWaveInstance } from "../../enums";

describe("Atoms functionality tests", () => {
    describe("Atom radii are element-specific (van der Waals)", () => {
        // Regression: settings.vdwRadii was built with Array.prototype.map over
        // Object.keys(PERIODIC_TABLE), producing a positional array indexed 0..117, while
        // getAtomRadiusByElement looks it up by element symbol. Every lookup therefore
        // returned undefined and fell back to settings.sphereRadius, so hydrogen and uranium
        // rendered at exactly the same size. The visual snapshot baselines could not catch
        // this - they were generated with the bug in place, which encoded it as correct.

        test("the radius map is keyed by element symbol, not by position", () => {
            const wave = getWaveInstance();
            const { vdwRadii } = wave.settings;

            expect(Array.isArray(vdwRadii)).toBe(false);
            expect(vdwRadii.Si).toBeCloseTo(PERIODIC_TABLE.Si.van_der_Waals_radius_pm / 100, 6);
        });

        test("radius varies by element and is not the sphereRadius fallback", () => {
            const wave = getWaveInstance();
            const { sphereRadius } = wave.settings;

            const radiusOfHydrogen = wave.getAtomRadiusByElement("H");
            const radiusOfCarbon = wave.getAtomRadiusByElement("C");
            const radiusOfSilicon = wave.getAtomRadiusByElement("Si");

            // Ordered by van der Waals radius: H (1.20) < C (1.70) < Si (2.10) Angstrom.
            expect(radiusOfHydrogen).toBeLessThan(radiusOfCarbon);
            expect(radiusOfCarbon).toBeLessThan(radiusOfSilicon);

            // The pre-fix behavior: all three collapsed onto sphereRadius.
            expect(radiusOfHydrogen).not.toBeCloseTo(sphereRadius, 6);
            expect(radiusOfSilicon).not.toBeCloseTo(sphereRadius, 6);
        });

        test("the scale factor is applied on top of the element radius", () => {
            const wave = getWaveInstance();
            const scale = 0.2;

            expect(wave.getAtomRadiusByElement("Si", scale)).toBeCloseTo(
                wave.getAtomRadiusByElement("Si") * scale,
                6,
            );
        });

        test("an unknown element falls back to sphereRadius", () => {
            const wave = getWaveInstance();

            expect(wave.getAtomRadiusByElement("NotAnElement")).toBeCloseTo(
                wave.settings.sphereRadius,
                6,
            );
        });
    });

    test("the spin glow follows the sign of the starting magnetization", () => {
        const wave = getFeOWaveInstance();
        const [spinUpIron, spinDownIron, oxygen] = wave.getAtomGroups();
        const ironColor = wave.getAtomColorByElement("Fe").toLowerCase();
        const [spinUpGlow, spinDownGlow] = [1, 2].map((glowOffset) => {
            const referenceMesh = wave.getSphereMeshObject({ color: ironColor });
            ApplyGlow(referenceMesh, ironColor, glowOffset);
            return referenceMesh.material.emissive.getHex();
        });

        expect(spinUpIron.material.emissive.getHex()).toEqual(spinUpGlow);
        expect(spinDownIron.material.emissive.getHex()).toEqual(spinDownGlow);
        expect(oxygen.material.emissiveIntensity).toEqual(1);
    });
});
