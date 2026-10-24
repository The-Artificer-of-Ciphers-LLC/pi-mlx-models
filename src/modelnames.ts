import { shown } from "./configdialogs.js";

/**
 * How /mlx-config names the model entries of the config file in titles and notices. Two keys can look the same once cleaned
 * and clipped, so a name carries the entry's place in the list whenever the text alone would not tell them apart (WR-02).
 * Built from the list of model keys as it is at that moment; rebuild it after the file changes.
 */

/** One menu line per name, numbered so two names that look alike once cleaned stay different lines. */
export const numbered = (names: string[]): string[] => names.map((name, index) => `${index + 1}. ${shown(name)}`);

export interface ModelNames {
  /**
   * A model as a notice or title names it: the cleaned, clipped key, and "(entry N of M)" after it only when another key of
   * the file shows the same text, so nothing changes for a key that is unique (WR-02c). A key not in the file yet is placed
   * where the sorted list will put it once it is written.
   */
  label(model: string): string;
  /**
   * A model entry as the menu numbers it, "3 of 5 (key)", for the questions that cannot be undone: two keys that look alike
   * once cleaned and clipped give the same `shown` text, but never the same place (WR-02, WR-02b). A key that is no longer
   * in the file has no place and is named by its text.
   */
  place(model: string): string;
}

/** The model keys of the file, sorted as the menu lists them. */
export function modelNames(keys: string[]): ModelNames {
  return {
    label(model) {
      const text = shown(model);
      if (!keys.some((other) => other !== model && shown(other) === text)) return text;
      const all = keys.includes(model) ? keys : [...keys, model].sort();
      return `${text} (entry ${all.indexOf(model) + 1} of ${all.length})`;
    },
    place(model) {
      const index = keys.indexOf(model);
      return index < 0 ? shown(model) : `${index + 1} of ${keys.length} (${shown(model)})`;
    },
  };
}
