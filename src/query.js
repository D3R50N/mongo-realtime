'use strict';

const { isDeepStrictEqual } = require('node:util');

function deepCopy(value) {
  if (value === undefined) {
    return undefined;
  }

  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === '[object Object]';
}

function readPath(document, path) {
  if (!path) {
    return document;
  }

  return path.split('.').reduce((current, segment) => {
    if (current && typeof current === 'object') {
      return current[segment];
    }
    return undefined;
  }, document);
}

function writePath(document, path, value) {
  const segments = path.split('.');
  let current = document;

  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    if (!isPlainObject(current[segment])) {
      current[segment] = {};
    }
    current = current[segment];
  }

  current[segments[segments.length - 1]] = value;
}

function compareValues(left, right) {
  if (left === right) {
    return 0;
  }
  if (left == null) {
    return -1;
  }
  if (right == null) {
    return 1;
  }
  if (typeof left === 'number' && typeof right === 'number') {
    return left - right;
  }
  if (typeof left === 'string' && typeof right === 'string') {
    return left.localeCompare(right);
  }
  if (typeof left === 'boolean' && typeof right === 'boolean') {
    return left === right ? 0 : left ? 1 : -1;
  }
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

function matchesFilter(document, filter = {}) {
  if (!isPlainObject(filter) || Object.keys(filter).length === 0) {
    return true;
  }

  return Object.entries(filter).every(([key, condition]) => {
    if (key === '$and') {
      return Array.isArray(condition) &&
          condition.every((clause) => matchesFilter(document, clause));
    }
    if (key === '$or') {
      return Array.isArray(condition) &&
          condition.some((clause) => matchesFilter(document, clause));
    }
    if (key === '$nor') {
      return Array.isArray(condition) &&
          condition.every((clause) => !matchesFilter(document, clause));
    }

    const value = readPath(document, key);
    return matchesCondition(value, condition);
  });
}

function matchesCondition(value, condition) {
  if (isPlainObject(condition) &&
      Object.keys(condition).some((key) => key.startsWith('$'))) {
    if ('$regex' in condition &&
        !matchesRegex(value, condition.$regex, condition.$options)) {
      return false;
    }

    return Object.entries(condition).every(([operator, operand]) => {
      if (operator === '$regex' || operator === '$options') {
        return true;
      }
      return applyOperator(value, operator, operand);
    });
  }

  if (Array.isArray(value)) {
    return value.some((item) => isDeepStrictEqual(item, condition));
  }

  return isDeepStrictEqual(value, condition);
}

function applyOperator(value, operator, operand) {
  switch (operator) {
    case '$eq':
      return isDeepStrictEqual(value, operand);
    case '$ne':
      return !isDeepStrictEqual(value, operand);
    case '$gt':
      return compareValues(value, operand) > 0;
    case '$gte':
      return compareValues(value, operand) >= 0;
    case '$lt':
      return compareValues(value, operand) < 0;
    case '$lte':
      return compareValues(value, operand) <= 0;
    case '$in':
      if (!Array.isArray(operand)) {
        return false;
      }
      if (Array.isArray(value)) {
        return value.some((item) =>
          operand.some((candidate) => isDeepStrictEqual(candidate, item)),
        );
      }
      return operand.some((candidate) => isDeepStrictEqual(candidate, value));
    case '$nin':
      if (!Array.isArray(operand)) {
        return false;
      }
      if (Array.isArray(value)) {
        return value.every((item) =>
          operand.every((candidate) => !isDeepStrictEqual(candidate, item)),
        );
      }
      return operand.every((candidate) => !isDeepStrictEqual(candidate, value));
    case '$exists':
      return operand ? value !== undefined : value === undefined;
    case '$regex':
      return matchesRegex(value, operand, undefined);
    case '$contains':
      if (Array.isArray(value)) {
        return value.some((item) => isDeepStrictEqual(item, operand));
      }
      if (typeof value === 'string' && typeof operand === 'string') {
        return value.includes(operand);
      }
      return false;
    default:
      return true;
  }
}

function matchesRegex(value, pattern, options) {
  if (typeof value !== 'string' || pattern == null) {
    return false;
  }

  const flags = typeof options === 'string' ? options : '';
  return new RegExp(String(pattern), flags).test(value);
}

function normalizeSort(sort = {}) {
  return Object.fromEntries(
    Object.entries(sort).map(([field, direction]) => [field, direction < 0 ? -1 : 1]),
  );
}

function sortDocuments(documents, sort = {}, limit = null) {
  const normalizedSort = normalizeSort(sort);
  const sorted = [...documents];

  if (Object.keys(normalizedSort).length > 0) {
    sorted.sort((left, right) => {
      for (const [field, direction] of Object.entries(normalizedSort)) {
        const comparison = compareValues(readPath(left, field), readPath(right, field));
        if (comparison !== 0) {
          return direction < 0 ? -comparison : comparison;
        }
      }
      return compareValues(String(left._id ?? ''), String(right._id ?? ''));
    });
  }

  if (typeof limit === 'number' && limit >= 0) {
    return sorted.slice(0, limit);
  }

  return sorted;
}

function isMongoOperatorUpdate(update) {
  return isPlainObject(update) &&
      Object.keys(update).some((key) => key.startsWith('$'));
}

function applyMongoUpdate(document, update) {
  const working = deepCopy(document);

  if (!isMongoOperatorUpdate(update)) {
    for (const [path, value] of Object.entries(update)) {
      writePath(working, path, deepCopy(value));
    }
    return working;
  }

  for (const [operator, payload] of Object.entries(update)) {
    const entries = isPlainObject(payload) ? Object.entries(payload) : [];

    switch (operator) {
      case '$set':
        for (const [path, value] of entries) {
          writePath(working, path, deepCopy(value));
        }
        break;
      case '$inc':
        for (const [path, value] of entries) {
          const current = readPath(working, path);
          const currentNumber = typeof current === 'number' ? current : 0;
          const delta = typeof value === 'number' ? value : 0;
          writePath(working, path, currentNumber + delta);
        }
        break;
      case '$addToSet':
        for (const [path, value] of entries) {
          const list = readOrCreateList(working, path);
          for (const candidate of expandUpdateValue(value)) {
            if (!list.some((item) => isDeepStrictEqual(item, candidate))) {
              list.push(deepCopy(candidate));
            }
          }
        }
        break;
      case '$push':
        for (const [path, value] of entries) {
          const list = readOrCreateList(working, path);
          for (const candidate of expandUpdateValue(value)) {
            list.push(deepCopy(candidate));
          }
        }
        break;
      case '$pull':
        for (const [path, value] of entries) {
          const list = readOrCreateList(working, path);
          for (let index = list.length - 1; index >= 0; index -= 1) {
            if (shouldPull(list[index], value)) {
              list.splice(index, 1);
            }
          }
        }
        break;
      default:
        break;
    }
  }

  return working;
}

function readOrCreateList(document, path) {
  const current = readPath(document, path);
  if (Array.isArray(current)) {
    return current;
  }

  const replacement = [];
  writePath(document, path, replacement);
  return replacement;
}

function expandUpdateValue(value) {
  if (isPlainObject(value) && Array.isArray(value.$each)) {
    return value.$each;
  }
  return [value];
}

function shouldPull(item, condition) {
  if (isPlainObject(condition) && isPlainObject(item)) {
    return matchesFilter(item, condition);
  }

  return isDeepStrictEqual(item, condition);
}

module.exports = {
  applyMongoUpdate,
  compareValues,
  deepCopy,
  isMongoOperatorUpdate,
  isPlainObject,
  matchesFilter,
  normalizeSort,
  readPath,
  sortDocuments,
  writePath,
};
