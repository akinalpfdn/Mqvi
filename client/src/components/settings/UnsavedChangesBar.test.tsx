/** The save bar shows only while something is unsaved, and saves when asked. */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

import UnsavedChangesBar from "./UnsavedChangesBar";

describe("the unsaved changes bar", () => {
  it("is not there while nothing has changed", () => {
    const { container } = render(<UnsavedChangesBar hasChanges={false} onSave={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it("says there are changes and saves them", () => {
    const onSave = vi.fn();
    render(<UnsavedChangesBar hasChanges onSave={onSave} />);

    expect(screen.getByText("unsavedChanges")).toBeTruthy();
    fireEvent.click(screen.getByRole("button"));
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("stays while saving, with the button off", () => {
    render(<UnsavedChangesBar hasChanges={false} isSaving onSave={vi.fn()} />);
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps the button off when the user may not save", () => {
    render(<UnsavedChangesBar hasChanges canSave={false} onSave={vi.fn()} />);
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
  });
});
