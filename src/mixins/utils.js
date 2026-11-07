import gifshot from "gifshot";
import * as THREE from "three";

export const UtilsMixin = (superclass) =>
    class extends superclass {
        // toggles a boolean variable and optionally sets all variables in the antagonists array to the opposite value
        toggleBoolean(name, antagonistNames = []) {
            this[name] = !this[name];
            // disable all antagonists when `name` variable is set to true
            const currentValue = this[name];
            if (currentValue && antagonistNames.length) {
                antagonistNames.forEach((antagonistName) => {
                    this[antagonistName] = !currentValue;
                });
            }
        }

        areTwoObjectsShallowEqual(o1, o2) {
            return Object.keys(o1)
                .map((key) => o1[key] === o2[key])
                .reduce((a, b) => a && b);
        }

        getTwoObjectsShallowDifferentKeys(o1, o2) {
            const resultingObject = {};
            const differentKeysArray = Object.keys(o1).filter((key) => o1[key] !== o2[key]);
            differentKeysArray.forEach((key) => (resultingObject[key] = true));
            return resultingObject;
        }
    };

/**
 * Applies glow to a THREE object.
 * @param meshObjet {Object}: THREE mesh object.
 * @param baseColor {String}: hex color string of the glow
 * @param offset {Number}: can be a single digit number, 0 means no offset; offset 1 shifts the hue
 *     by -0.1 and offset 2 by +0.1: 1 marks positive and 2 negative starting magnetization
 */
export const ApplyGlow = (meshObjet, baseColor, offset = 0) => {
    const atomHSL = {};
    new THREE.Color(baseColor).getHSL(atomHSL);
    let hue, saturation;
    if (offset !== 0) {
        if (offset % 2 === 0) {
            hue = atomHSL.h + (offset * 0.1) / 2;
            saturation = atomHSL.s + (offset * 0.1) / 2;
        } else {
            hue = atomHSL.h - ((offset + 1) * 0.1) / 2;
            saturation = atomHSL.s + ((offset + 1) * 0.1) / 2;
        }

        // hue is cyclic
        while (hue > 1) {
            hue -= 1;
        }

        while (hue < 0) {
            hue += 1;
        }

        saturation = Math.max(0, Math.min(1, saturation));
        meshObjet.material.emissiveIntensity = 0.25;
        meshObjet.material.emissive.setHSL(hue, saturation, atomHSL.l);
    }
};

export function createGIFAsync({
    images,
    gifWidth,
    gifHeight,
    numFrames,
    frameDuration,
    sampleInterval,
}) {
    return new Promise((resolve, reject) => {
        gifshot.createGIF(
            { images, gifWidth, gifHeight, numFrames, frameDuration, sampleInterval },
            (obj) => {
                if (!obj.error) {
                    resolve(obj.image); // Resolve with the GIF data URL
                } else {
                    reject(obj.error); // Reject with the error
                }
            },
        );
    });
}
