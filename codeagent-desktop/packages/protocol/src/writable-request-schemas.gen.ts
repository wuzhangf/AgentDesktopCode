// Generated from the canonical writable collaboration OpenAPI schemas.
export const writableRequestSchemas = {
  "WritableCollaborationBudget": {
    "type": "object",
    "properties": {
      "logicalCalls": {
        "type": "string",
        "pattern": "^(0|[1-9][0-9]{0,18})$",
        "default": "0"
      },
      "httpRequests": {
        "type": "string",
        "pattern": "^(0|[1-9][0-9]{0,18})$",
        "default": "0"
      },
      "editAttempts": {
        "type": "string",
        "pattern": "^(0|[1-9][0-9]{0,18})$",
        "default": "0"
      }
    },
    "additionalProperties": false
  },
  "WritableGraphUnit": {
    "type": "object",
    "properties": {
      "unitId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
        "maxLength": 128
      },
      "kind": {
        "type": "string",
        "enum": [
          "READ_ONLY",
          "WRITE_CANDIDATE"
        ]
      },
      "objective": {
        "type": "string",
        "minLength": 1,
        "maxLength": 16000
      },
      "agentProfileId": {
        "type": "string",
        "default": "default"
      },
      "modelAlias": {
        "type": "string",
        "maxLength": 128
      },
      "readScope": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 1024
        },
        "maxItems": 128
      },
      "writeScope": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 1024
        },
        "maxItems": 128
      },
      "dependsOn": {
        "type": "array",
        "items": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
          "maxLength": 128
        },
        "maxItems": 7
      },
      "required": {
        "type": "boolean",
        "default": true
      },
      "allowNoChanges": {
        "type": "boolean",
        "default": false
      }
    },
    "additionalProperties": false,
    "required": [
      "unitId",
      "kind",
      "objective",
      "readScope"
    ]
  },
  "WritableCollaborationGraph": {
    "type": "object",
    "properties": {
      "schemaVersion": {
        "type": "string",
        "enum": [
          "collaboration-graph/1"
        ],
        "default": "collaboration-graph/1"
      },
      "samePathMode": {
        "type": "string",
        "enum": [
          "REJECT",
          "DEPENDENCY_CHAIN"
        ],
        "default": "REJECT"
      },
      "requestedParallelism": {
        "type": "integer",
        "minimum": 1,
        "maximum": 4,
        "default": 2
      },
      "units": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/WritableGraphUnit"
        },
        "maxItems": 8,
        "minItems": 1
      }
    },
    "additionalProperties": false,
    "required": [
      "units"
    ]
  },
  "WriteGroupCreateRequest": {
    "type": "object",
    "properties": {
      "schemaVersion": {
        "type": "string",
        "enum": [
          "collaboration-group-create/1"
        ],
        "default": "collaboration-group-create/1"
      },
      "requestId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
        "maxLength": 128
      },
      "expectedExecutionEpoch": {
        "type": "string",
        "pattern": "^(0|[1-9][0-9]{0,18})$"
      },
      "graph": {
        "$ref": "#/components/schemas/WritableCollaborationGraph"
      }
    },
    "additionalProperties": false,
    "required": [
      "requestId",
      "expectedExecutionEpoch",
      "graph"
    ]
  },
  "WritableUnitBudget": {
    "type": "object",
    "properties": {
      "unitId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
        "maxLength": 128
      },
      "total": {
        "$ref": "#/components/schemas/WritableCollaborationBudget"
      },
      "perAttempt": {
        "$ref": "#/components/schemas/WritableCollaborationBudget"
      }
    },
    "additionalProperties": false,
    "required": [
      "unitId",
      "total",
      "perAttempt"
    ]
  },
  "WriteGroupAuthorizeRequest": {
    "type": "object",
    "properties": {
      "schemaVersion": {
        "type": "string",
        "enum": [
          "collaboration-group-authorization/1"
        ],
        "default": "collaboration-group-authorization/1"
      },
      "requestId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
        "maxLength": 128
      },
      "expectedGraphRevision": {
        "type": "string",
        "pattern": "^(0|[1-9][0-9]{0,18})$"
      },
      "expectedExecutionEpoch": {
        "type": "string",
        "pattern": "^(0|[1-9][0-9]{0,18})$"
      },
      "graphFingerprint": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "adoptionMode": {
        "type": "string",
        "enum": [
          "USER_CONFIRM",
          "PARENT_WITHIN_GRANT"
        ],
        "default": "USER_CONFIRM"
      },
      "retryLimit": {
        "type": "integer",
        "minimum": 0,
        "maximum": 1,
        "default": 1
      },
      "repairLimit": {
        "type": "integer",
        "minimum": 0,
        "maximum": 1,
        "default": 0
      },
      "integrationReserve": {
        "$ref": "#/components/schemas/WritableCollaborationBudget"
      },
      "repairReserve": {
        "$ref": "#/components/schemas/WritableCollaborationBudget"
      },
      "units": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/WritableUnitBudget"
        },
        "maxItems": 8,
        "minItems": 1
      }
    },
    "additionalProperties": false,
    "required": [
      "requestId",
      "expectedGraphRevision",
      "graphFingerprint",
      "units",
      "integrationReserve"
    ]
  },
  "WriteGroupStartRequest": {
    "type": "object",
    "properties": {
      "schemaVersion": {
        "type": "string",
        "enum": [
          "collaboration-group-start/1"
        ],
        "default": "collaboration-group-start/1"
      },
      "startId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
        "maxLength": 128
      },
      "expectedGraphRevision": {
        "type": "string",
        "pattern": "^(0|[1-9][0-9]{0,18})$"
      },
      "grantFingerprint": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "expectedExecutionEpoch": {
        "type": "string",
        "pattern": "^(0|[1-9][0-9]{0,18})$"
      }
    },
    "additionalProperties": false,
    "required": [
      "startId",
      "expectedGraphRevision",
      "grantFingerprint",
      "expectedExecutionEpoch"
    ]
  },
  "WritableSelectedUnit": {
    "type": "object",
    "properties": {
      "unitId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
        "maxLength": 128
      },
      "candidateId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
        "maxLength": 128
      },
      "candidateFingerprint": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      }
    },
    "additionalProperties": false,
    "required": [
      "unitId",
      "candidateId",
      "candidateFingerprint"
    ]
  },
  "WriteSelectionRequest": {
    "type": "object",
    "properties": {
      "schemaVersion": {
        "type": "string",
        "enum": [
          "collaboration-selection/1"
        ],
        "default": "collaboration-selection/1"
      },
      "selectionId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
        "maxLength": 128
      },
      "expectedGraphRevision": {
        "type": "string",
        "pattern": "^(0|[1-9][0-9]{0,18})$"
      },
      "dependencyPolicy": {
        "type": "string",
        "enum": [
          "REQUIRE_CLOSURE"
        ],
        "default": "REQUIRE_CLOSURE"
      },
      "units": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/WritableSelectedUnit"
        },
        "maxItems": 8,
        "minItems": 1
      }
    },
    "additionalProperties": false,
    "required": [
      "selectionId",
      "expectedGraphRevision",
      "units"
    ]
  },
  "WritePreviewRequest": {
    "type": "object",
    "properties": {
      "schemaVersion": {
        "type": "string",
        "enum": [
          "collaboration-preview-request/1"
        ],
        "default": "collaboration-preview-request/1"
      },
      "previewId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
        "maxLength": 128
      },
      "selectionId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
        "maxLength": 128
      },
      "selectionFingerprint": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "mode": {
        "type": "string",
        "enum": [
          "STRICT",
          "THREE_WAY"
        ],
        "default": "STRICT"
      }
    },
    "additionalProperties": false,
    "required": [
      "previewId",
      "selectionFingerprint"
    ]
  },
  "WritableResolution": {
    "type": "object",
    "properties": {
      "path": {
        "type": "string",
        "maxLength": 1024
      },
      "choice": {
        "type": "string",
        "enum": [
          "KEEP_CURRENT",
          "TAKE_PROPOSED",
          "MANUAL"
        ],
        "default": "MANUAL"
      },
      "text": {
        "type": "string",
        "maxLength": 1048576
      }
    },
    "additionalProperties": false,
    "required": [
      "path"
    ]
  },
  "WritePreviewRevisionRequest": {
    "type": "object",
    "properties": {
      "schemaVersion": {
        "type": "string",
        "enum": [
          "collaboration-preview-revision/1"
        ],
        "default": "collaboration-preview-revision/1"
      },
      "revisionId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
        "maxLength": 128
      },
      "previewFingerprint": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "strategy": {
        "type": "string",
        "enum": [
          "MANUAL",
          "MODEL_PROPOSAL"
        ],
        "default": "MANUAL"
      },
      "reason": {
        "type": "string",
        "minLength": 1,
        "maxLength": 2000
      },
      "reviewId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
        "maxLength": 128
      },
      "resolutions": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/WritableResolution"
        },
        "maxItems": 64
      }
    },
    "additionalProperties": false,
    "required": [
      "revisionId",
      "previewFingerprint",
      "reason"
    ]
  },
  "WriteAdoptionRequest": {
    "type": "object",
    "properties": {
      "schemaVersion": {
        "type": "string",
        "enum": [
          "collaboration-adoption/1"
        ],
        "default": "collaboration-adoption/1"
      },
      "adoptionId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
        "maxLength": 128
      },
      "expectedRunStateVersion": {
        "type": "string",
        "pattern": "^(0|[1-9][0-9]{0,18})$"
      },
      "expectedExecutionEpoch": {
        "type": "string",
        "pattern": "^(0|[1-9][0-9]{0,18})$"
      },
      "selectionId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
        "maxLength": 128
      },
      "selectionFingerprint": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "previewId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
        "maxLength": 128
      },
      "previewFingerprint": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "mode": {
        "type": "string",
        "enum": [
          "STRICT",
          "THREE_WAY"
        ],
        "default": "STRICT"
      },
      "reviewId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
        "maxLength": 128
      },
      "revalidationDecision": {
        "type": "string",
        "enum": [
          "GOAL_REVALIDATED"
        ]
      }
    },
    "additionalProperties": false,
    "required": [
      "adoptionId",
      "expectedRunStateVersion",
      "expectedExecutionEpoch",
      "selectionId",
      "selectionFingerprint",
      "previewId",
      "previewFingerprint"
    ]
  },
  "WriteActionRequest": {
    "type": "object",
    "properties": {
      "schemaVersion": {
        "type": "string",
        "enum": [
          "collaboration-action/1"
        ],
        "default": "collaboration-action/1"
      },
      "requestId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
        "maxLength": 128
      },
      "expectedRevision": {
        "type": "string",
        "pattern": "^(0|[1-9][0-9]{0,18})$"
      },
      "reason": {
        "type": "string",
        "maxLength": 2000
      }
    },
    "additionalProperties": false,
    "required": [
      "requestId"
    ]
  },
  "WriteReviewRequest": {
    "type": "object",
    "properties": {
      "schemaVersion": {
        "type": "string",
        "enum": [
          "collaboration-review/1"
        ],
        "default": "collaboration-review/1"
      },
      "reviewId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
        "maxLength": 128
      },
      "previewFingerprint": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "modelAlias": {
        "type": "string",
        "maxLength": 128
      },
      "question": {
        "type": "string",
        "minLength": 1,
        "maxLength": 4000
      },
      "budgetSource": {
        "type": "string",
        "enum": [
          "PARENT_REMAINING"
        ],
        "default": "PARENT_REMAINING"
      },
      "purpose": {
        "type": "string",
        "enum": [
          "REVIEW",
          "REVISION_PROPOSAL"
        ],
        "default": "REVIEW"
      },
      "budget": {
        "$ref": "#/components/schemas/WritableCollaborationBudget"
      }
    },
    "additionalProperties": false,
    "required": [
      "reviewId",
      "previewFingerprint",
      "question",
      "budget"
    ]
  },
  "WriteRepairRequest": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "schemaVersion": {
        "type": "string",
        "enum": [
          "collaboration-repair-request/1"
        ],
        "default": "collaboration-repair-request/1"
      },
      "repairId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
        "maxLength": 128
      },
      "expectedAdoptionRevision": {
        "type": "string",
        "pattern": "^[1-9][0-9]{0,18}$",
        "maxLength": 19
      },
      "expectedRunStateVersion": {
        "type": "string",
        "pattern": "^[1-9][0-9]{0,18}$",
        "maxLength": 19
      },
      "expectedExecutionEpoch": {
        "type": "string",
        "pattern": "^[1-9][0-9]{0,18}$",
        "maxLength": 19
      },
      "objective": {
        "type": "string",
        "minLength": 1,
        "maxLength": 2000
      }
    },
    "required": [
      "repairId",
      "expectedAdoptionRevision",
      "expectedRunStateVersion",
      "expectedExecutionEpoch",
      "objective"
    ]
  }
} as const;
