import { Made } from "@mat3ra/made";
import fs from "fs";
import path from "path";

// canvas element width/height
import { Wave } from "../src/wave";
// move width, height to utils to avoid import cycle
import { createElement, HEIGHT, WIDTH } from "./utils";

// used to override width/height element getters.
export const ELEMENT_PROPERTIES = {
    width: { value: WIDTH },
    height: { value: HEIGHT },
    clientWidth: { value: WIDTH },
    clientHeight: { value: HEIGHT },
};

// default material config
const materialJsonFilePath = path.resolve(__dirname, "fixtures/material.json");
export const MATERIAL_CONFIG = JSON.parse(fs.readFileSync(materialJsonFilePath));

// config for FeO with Fe +0.5 / -0.5 starting magnetization
const FeOJsonFilePath = path.resolve(__dirname, "fixtures/FeO.json");
export const FeO_CONFIG = JSON.parse(fs.readFileSync(FeOJsonFilePath));

export const WAVE_SETTINGS = {
    atomRadiiScale: 0.2,
    repetitions: 1,
};

export function getWaveInstance(settings, material = new Made.Material(MATERIAL_CONFIG)) {
    return new Wave({
        DOMElement: createElement("div", ELEMENT_PROPERTIES),
        structure: material,
        cell: material.getLattice().unitCell,
        settings: settings || WAVE_SETTINGS,
    });
}

export function getFeOWaveInstance(settings, material = new Made.Material(FeO_CONFIG)) {
    return new Wave({
        DOMElement: createElement("div", ELEMENT_PROPERTIES),
        structure: material,
        cell: material.getLattice().unitCell,
        settings: settings || WAVE_SETTINGS,
    });
}
