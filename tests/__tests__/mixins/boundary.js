import { Made } from "@mat3ra/made";
import expect from "expect";
import { mix } from "mixwith";

import { BoundaryMixin } from "../../../src/mixins/boundary";
import { FeO_CONFIG, MATERIAL_CONFIG } from "../../enums";

class BoundaryMixinTestBase {
    constructor(config) {
        this.boundaryConditions = config.boundaryConditions || {};
        const material = new Made.Material(MATERIAL_CONFIG);
        this.basis = material.getBasis();
    }
}

const BoundaryMixinTestClass = mix(BoundaryMixinTestBase).with(BoundaryMixin);

test("basisWithElementsInsideNonPeriodicBoundaries with bc1 does not throw", () => {
    const instance = new BoundaryMixinTestClass({
        boundaryConditions: { type: "bc1", offset: 0 },
    });

    expect(instance.basisWithElementsInsideNonPeriodicBoundaries.elements.length).toBeGreaterThan(
        0,
    );
});

test("basisWithElementsInsideNonPeriodicBoundaries keeps atom ids and each atom's label", () => {
    const instance = new BoundaryMixinTestClass({
        boundaryConditions: { type: "bc1", offset: 0 },
    });
    // Removing atom 0 leaves ids 1, 2, 3, with label 2 on atom 1.
    instance.basis = new Made.Material(FeO_CONFIG).getBasis().filterAtomsByIds(0, true);

    const basis = instance.basisWithElementsInsideNonPeriodicBoundaries;

    expect(basis.elements.map(({ id }) => id)).toEqual([1, 2, 3]);
    expect(basis.elementsWithLabelsArray).toEqual(["Fe2", "O", "O"]);
});
