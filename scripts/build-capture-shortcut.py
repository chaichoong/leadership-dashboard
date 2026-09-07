#!/usr/bin/env python3
"""Rebuild the "Capture" Apple Shortcut (watch Action button -> Apple Notes).

What it does on the watch: dictate, then add the text as a reminder on the
"Captures" list in Apple Reminders (iCloud). The watch cannot write into Apple Notes
(Find Note / Append to Note only run on iPhone and Mac; tried 7 Sep 2026), but it can
add a reminder. ~/knowledge-os/apple_notes_bridge.sh pulls that list into the AI brain
inbox every night at 22:40 alongside the Apple Notes "Brain" folder.

On the Mac the same shortcut accepts text input instead of dictating, which is how
it is tested without a microphone:

    python3 scripts/build-capture-shortcut.py            # writes Capture.shortcut
    shortcuts sign --mode anyone -i Capture.shortcut -o signed/Capture.shortcut
    open signed/Capture.shortcut                          # click "Add Shortcut"
    printf 'test line' > in.txt && shortcuts run Capture -i in.txt

The file NAME becomes the shortcut name, so sign to a file called Capture.shortcut.
Built 7 Sep 2026. Replaces the old "Add Task" watch shortcut, which posted to the
apple-inbound worker and created tasks Kevin no longer works from.
"""
import plistlib
import sys
import uuid

LIST_NAME = "Captures"


def build():
    new = lambda: str(uuid.uuid4()).upper()
    group, text_id, dictate_id, end_if, find_id, append_id = (new() for _ in range(6))
    shortcut_input = {"Value": {"Type": "ExtensionInput"}, "WFSerializationType": "WFTextTokenAttachment"}
    actions = [
        # If the shortcut was given input (Mac test), use it. Otherwise dictate (watch).
        {"WFWorkflowActionIdentifier": "is.workflow.actions.conditional", "WFWorkflowActionParameters": {
            "GroupingIdentifier": group, "WFControlFlowMode": 0, "WFCondition": 100,
            "WFInput": {"Type": "Variable", "Variable": shortcut_input}}},
        {"WFWorkflowActionIdentifier": "is.workflow.actions.gettext", "WFWorkflowActionParameters": {
            "UUID": text_id,
            "WFTextActionText": {"Value": {"attachmentsByRange": {"{0, 1}": {"Type": "ExtensionInput"}}, "string": "￼"},
                                 "WFSerializationType": "WFTextTokenString"}}},
        {"WFWorkflowActionIdentifier": "is.workflow.actions.conditional", "WFWorkflowActionParameters": {
            "GroupingIdentifier": group, "WFControlFlowMode": 1}},
        {"WFWorkflowActionIdentifier": "is.workflow.actions.dictatetext", "WFWorkflowActionParameters": {
            "UUID": dictate_id, "WFDictateTextStopListening": "After Pause"}},
        {"WFWorkflowActionIdentifier": "is.workflow.actions.conditional", "WFWorkflowActionParameters": {
            "GroupingIdentifier": group, "WFControlFlowMode": 2, "UUID": end_if}},
        # Add the text as a reminder on the "Captures" list.
        {"WFWorkflowActionIdentifier": "is.workflow.actions.addnewreminder", "WFWorkflowActionParameters": {
            "UUID": find_id,
            "WFCalendarItemTitle": {"Value": {"attachmentsByRange": {"{0, 1}": {"OutputName": "If Result", "OutputUUID": end_if, "Type": "ActionOutput"}},
                                              "string": "￼"},
                                    "WFSerializationType": "WFTextTokenString"},
            "WFCalendarItemCalendar": LIST_NAME}},
    ]
    return {
        "WFWorkflowClientVersion": "2607.0.3",
        "WFWorkflowMinimumClientVersion": 900,
        "WFWorkflowMinimumClientVersionString": "900",
        "WFWorkflowIcon": {"WFWorkflowIconStartColor": 4282601983, "WFWorkflowIconGlyphNumber": 59511},
        "WFWorkflowTypes": ["WatchKit", "NCWidget"],  # WatchKit = "Show on Apple Watch"
        "WFWorkflowHasShortcutInputVariables": True,
        "WFWorkflowInputContentItemClasses": ["WFStringContentItem", "WFGenericFileContentItem"],
        "WFWorkflowImportQuestions": [],
        "WFWorkflowActions": actions,
    }


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "Capture.shortcut"
    with open(out, "wb") as fh:
        plistlib.dump(build(), fh)
    print("wrote", out)
