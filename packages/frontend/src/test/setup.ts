/**
 * Registers the DOM matchers (`toBeInTheDocument`, `toHaveTextContent`, …) for every test
 * file, so individual tests do not each have to remember to import them.
 */
import "@testing-library/jest-dom/vitest";
