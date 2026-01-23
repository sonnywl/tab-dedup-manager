// https://gist.github.com/alguerocode/a79bf0a8a097fccfa0abed92f65f8d60

export default function deepEquals(value1, value2) {
  if (typeof value1 !== typeof value2) return false;
  if (value1 === value2) return true;

  if (typeof value1 !== "object" && typeof value2 !== "object") {
    // NaN type validation;
    const [isValue1NaN, isValue2NaN] = [...arguments].map(
      (value) => Number.isNaN(value) && typeof value === "number",
    );
    if (isValue1NaN && isValue2NaN) return true;

    return value1 === value2;
  }

  if (Array.isArray(value1) && Array.isArray(value2)) {
    if (value1.length !== value2.length) return false;

    // check the element all are same
    for (let i = 0; i < value1.length; i++) {
      if (!deepEquals(value1[i], value2[i])) return false;
    }

    return true;
  }

  if (Array.isArray(value1) || Array.isArray(value2)) return false;

  // check the two values not null and not the same reference
  if (value1 !== value2) {
    const value1Keys = Object.keys(value1);
    const value2Keys = Object.keys(value2);

    if (value1Keys.length != value2Keys.length) return false;

    const isEqual = value1Keys.every((key) => {
      return value2Keys.includes(key) && deepEquals(value1[key], value2[key]);
    });

    return isEqual;
  }

  return true;
}
