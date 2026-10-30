/**
 * Minimal glob matching for project-relative, forward-slash paths.
 * Supports `**`, `*`, `?`, and a leading `!` to re-allow a path that an
 * earlier pattern in the same list matched.
 */
export function globToRegExp(pattern: string, caseInsensitive: boolean): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      if (pattern[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp("^" + source + "$", caseInsensitive ? "i" : "");
}

export function matchesPatternList(
  relativePath: string,
  patterns: readonly string[],
  caseInsensitive: boolean = process.platform === "win32" || process.platform === "darwin",
): boolean {
  let matched = false;
  for (const pattern of patterns) {
    const negated = pattern.startsWith("!");
    const body = negated ? pattern.slice(1) : pattern;
    if (globToRegExp(body, caseInsensitive).test(relativePath)) {
      matched = !negated;
    }
  }
  return matched;
}
