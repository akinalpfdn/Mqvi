import "@testing-library/jest-dom/vitest";
import { ResizeObserverStub } from "./resizeObserverStub";

globalThis.ResizeObserver = ResizeObserverStub;
