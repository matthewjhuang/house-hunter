#!/usr/bin/env python3
"""Builds shortcut/add-to-house-hunter.unsigned.shortcut, the iOS Share Sheet Shortcut.

Sign it on a Mac (needs iCloud) to make the file people can import:
    python3 shortcut/build.py
    shortcuts sign --mode anyone --input "shortcut/Add to House Hunter.unsigned.shortcut" --output add-to-house-hunter.shortcut

What it does when you share a listing:
  0. Text: your House Hunter token (asked once, when the Shortcut is added)
  1-2. Get URLs from Input, first one: the link, whether a Safari page, a link or text
     was shared (the text of a Safari page is only its title)
  3. Get Type of what was shared
  4. If it's a Safari web page: 5. Run JavaScript on it to read the page exactly as
     you're seeing it (the sites can't block this — it's already loaded)
  7. POST { url, html, source } to share-listing with "Bearer <token>"
  8. Show Notification with the reply ("Filled in 4/17 Clyde Street, Kew East")
  9. Shared from the REA/Domain apps (only a link, which the sites won't let anyone
     read): the reply says "Opening it in Safari", so 10-11 open the listing in Safari
     (x-safari-https:// keeps it out of the apps) for one more Share tap.

On a Mac, Safari also needs Develop → Allow JavaScript from Apple Events.
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


token, links, first, kind, reply, safari_url = uid(), uid(), uid(), uid(), uid(), uid()
outer, outer_end, reopen = uid(), uid(), uid()


def conditional(group, mode, **params):
    return {"WFWorkflowActionIdentifier": "is.workflow.actions.conditional",
            "WFWorkflowActionParameters": {"UUID": params.pop("uuid", uid()), "GroupingIdentifier": group,
                                           "WFControlFlowMode": mode, **params}}


actions = [
    {"WFWorkflowActionIdentifier": "is.workflow.actions.gettext",
     "WFWorkflowActionParameters": {"UUID": token, "WFTextActionText": ""}},
    {"WFWorkflowActionIdentifier": "is.workflow.actions.detect.link",
     "WFWorkflowActionParameters": {"UUID": links, "WFInput": attachment(extension_input=True)}},
    {"WFWorkflowActionIdentifier": "is.workflow.actions.getitemfromlist",
     "WFWorkflowActionParameters": {"UUID": first, "WFInput": attachment(links, "URLs"), "WFItemSpecifier": "First Item"}},
    {"WFWorkflowActionIdentifier": "is.workflow.actions.getitemtype",
     "WFWorkflowActionParameters": {"UUID": kind, "WFInput": attachment(extension_input=True)}},
    # If shared from Safari: read the page that's open.
    conditional(outer, 0, WFCondition=99, WFConditionalActionString="Safari",
                WFInput={"Type": "Variable", "Variable": attachment(kind, "Type")}),
    {"WFWorkflowActionIdentifier": "is.workflow.actions.runjavascriptonwebpage",
     "WFWorkflowActionParameters": {"UUID": uid(), "WFInput": attachment(extension_input=True),
                                    "WFJavaScript": "completion(document.documentElement.outerHTML);"}},
    conditional(outer, 2, uuid=outer_end),
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
             ("html", text_with("", outer_end, "If Result")),
             ("source", text_with("", kind, "Type")),
         ]),
     }},
    {"WFWorkflowActionIdentifier": "is.workflow.actions.notification",
     "WFWorkflowActionParameters": {"WFNotificationActionTitle": text("House Hunter"),
                                    "WFNotificationActionBody": text_with("", reply, "Contents of URL")}},
    # Shared from an app: open the listing in Safari so one more share fills the card.
    conditional(reopen, 0, WFCondition=99, WFConditionalActionString="Opening it in Safari",
                WFInput={"Type": "Variable", "Variable": attachment(reply, "Contents of URL")}),
    {"WFWorkflowActionIdentifier": "is.workflow.actions.url",
     "WFWorkflowActionParameters": {"UUID": safari_url, "WFURLActionURL": text_with("x-safari-", first, "Item from List")}},
    {"WFWorkflowActionIdentifier": "is.workflow.actions.openurl",
     "WFWorkflowActionParameters": {"WFInput": attachment(safari_url, "URL")}},
    conditional(reopen, 2),
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

out = Path(__file__).with_name("Add to House Hunter.unsigned.shortcut")
out.write_bytes(plistlib.dumps(shortcut, fmt=plistlib.FMT_BINARY))
print(out)
