#!/usr/bin/env python3
"""Builds shortcut/add-to-house-hunter.unsigned.shortcut, the iOS Share Sheet Shortcut.

Sign it on a Mac (needs iCloud) to make the file people can import:
    python3 shortcut/build.py
    shortcuts sign --mode anyone --input shortcut/add-to-house-hunter.unsigned.shortcut --output add-to-house-hunter.shortcut

What it does when you share a listing:
  0. Text: your House Hunter token (asked once, when the Shortcut is added)
  1. Text: whatever was shared (apps share a bare link, "Check out … https://…" text,
     or a rich item — as text, all of them contain the link)
  2. Match Text https?://… and 3. take the first match
  4. If a link was found: 5. Get Contents of URL — reads the listing on the phone
     (sites rarely block phones)
  7. POST { url, html } to the share-listing Edge Function with "Bearer <token>"
     (with no link, the reply says so instead of the Shortcut erroring)
  8. Show Notification with the reply ("Added 4/17 Clyde Street, Kew East")
"""
import plistlib
import uuid
from pathlib import Path

ENDPOINT = "https://esifddbuuyztqcqqebgx.supabase.co/functions/v1/share-listing"
OBJ = "￼"  # placeholder character Shortcuts uses for a variable inside text


def uid():
    return str(uuid.uuid4()).upper()


def text(s):
    return {"WFSerializationType": "WFTextTokenString", "Value": {"string": s}}


def text_with(prefix, output_uuid, output_name):
    return {
        "WFSerializationType": "WFTextTokenString",
        "Value": {
            "string": prefix + OBJ,
            "attachmentsByRange": {
                f"{{{len(prefix)}, 1}}": {"Type": "ActionOutput", "OutputUUID": output_uuid, "OutputName": output_name}
            },
        },
    }


def attachment(output_uuid=None, output_name=None, extension_input=False):
    value = {"Type": "ExtensionInput"} if extension_input else {"Type": "ActionOutput", "OutputUUID": output_uuid, "OutputName": output_name}
    return {"WFSerializationType": "WFTextTokenAttachment", "Value": value}


def dictionary(items):
    return {
        "WFSerializationType": "WFDictionaryFieldValue",
        "Value": {"WFDictionaryFieldValueItems": [{"WFItemType": 0, "WFKey": text(k), "WFValue": v} for k, v in items]},
    }


token, shared, matches, first, page, reply = uid(), uid(), uid(), uid(), uid(), uid()
group = uid()

shared_text = {
    "WFSerializationType": "WFTextTokenString",
    "Value": {"string": OBJ, "attachmentsByRange": {"{0, 1}": {"Type": "ExtensionInput"}}},
}

actions = [
    {"WFWorkflowActionIdentifier": "is.workflow.actions.gettext",
     "WFWorkflowActionParameters": {"UUID": token, "WFTextActionText": ""}},
    {"WFWorkflowActionIdentifier": "is.workflow.actions.gettext",
     "WFWorkflowActionParameters": {"UUID": shared, "WFTextActionText": shared_text}},
    {"WFWorkflowActionIdentifier": "is.workflow.actions.text.match",
     "WFWorkflowActionParameters": {"UUID": matches, "WFMatchTextPattern": r"https?://[^\s<>\"']+",
                                    "WFMatchTextCaseSensitive": False, "text": text_with("", shared, "Text")}},
    {"WFWorkflowActionIdentifier": "is.workflow.actions.getitemfromlist",
     "WFWorkflowActionParameters": {"UUID": first, "WFInput": attachment(matches, "Matches"), "WFItemSpecifier": "First Item"}},
    {"WFWorkflowActionIdentifier": "is.workflow.actions.conditional",
     "WFWorkflowActionParameters": {"UUID": uid(), "GroupingIdentifier": group, "WFControlFlowMode": 0,
                                    "WFCondition": 100,  # "has any value"
                                    "WFInput": {"Type": "Variable", "Variable": attachment(first, "Item from List")}}},
    {"WFWorkflowActionIdentifier": "is.workflow.actions.downloadurl",
     "WFWorkflowActionParameters": {"UUID": page, "WFURL": text_with("", first, "Item from List"), "WFHTTPMethod": "GET"}},
    {"WFWorkflowActionIdentifier": "is.workflow.actions.conditional",
     "WFWorkflowActionParameters": {"UUID": uid(), "GroupingIdentifier": group, "WFControlFlowMode": 2}},
    {"WFWorkflowActionIdentifier": "is.workflow.actions.downloadurl",
     "WFWorkflowActionParameters": {
         "UUID": reply,
         "WFURL": ENDPOINT,
         "WFHTTPMethod": "POST",
         "ShowHeaders": True,
         "WFHTTPHeaders": dictionary([("Authorization", text_with("Bearer ", token, "Text"))]),
         "WFHTTPBodyType": "JSON",
         "WFJSONValues": dictionary([
             ("url", text_with("", first, "Item from List")),
             ("html", text_with("", page, "Contents of URL")),
         ]),
     }},
    {"WFWorkflowActionIdentifier": "is.workflow.actions.notification",
     "WFWorkflowActionParameters": {"WFNotificationActionTitle": text("House Hunter"),
                                    "WFNotificationActionBody": text_with("", reply, "Contents of URL")}},
]

shortcut = {
    "WFWorkflowClientVersion": "2302.0.4",
    "WFWorkflowMinimumClientVersion": 900,
    "WFWorkflowMinimumClientVersionString": "900",
    "WFWorkflowIcon": {"WFWorkflowIconStartColor": 463140863, "WFWorkflowIconGlyphNumber": 59446},
    "WFWorkflowTypes": ["ActionExtension"],
    "WFWorkflowInputContentItemClasses": ["WFURLContentItem", "WFStringContentItem", "WFSafariWebPageContentItem"],
    "WFWorkflowHasShortcutInputVariables": True,
    "WFWorkflowOutputContentItemClasses": [],
    "WFQuickActionSurfaces": [],
    "WFWorkflowImportQuestions": [{
        "ActionIndex": 0,
        "Category": "Parameter",
        "ParameterKey": "WFTextActionText",
        "DefaultValue": "",
        "Text": "Paste your House Hunter token (House Hunter → Settings → Create Your Shortcut Token)",
    }],
    "WFWorkflowActions": actions,
}

out = Path(__file__).with_name("add-to-house-hunter.unsigned.shortcut")
out.write_bytes(plistlib.dumps(shortcut, fmt=plistlib.FMT_BINARY))
print(out)
