/**
 * Rule-based structural validation for a parsed {@link DexpiModel}.
 *
 * This is not a full XSD validation (that is offered separately via
 * `osiris-dexpi.schemaPath`); it catches the mistakes that make a P&ID
 * unusable downstream: missing identifiers, unresolved references, dangling
 * connections and duplicated IDs.
 */
import type { DexpiModel, DexpiNode, ValidationIssue } from '@osiris/shared-core';

export interface ValidateOptions {
  /** Attributes every top-level component must carry. */
  requiredEquipmentAttributes?: string[];
}

const DEFAULT_REQUIRED_EQUIPMENT_ATTRS = ['ID', 'ComponentClass'];

function issue(
  severity: ValidationIssue['severity'],
  code: string,
  message: string,
  path: string,
  nodeId?: string,
): ValidationIssue {
  return { severity, code, message, path, nodeId };
}

export function validateDexpi(model: DexpiModel, options: ValidateOptions = {}): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const required = options.requiredEquipmentAttributes ?? DEFAULT_REQUIRED_EQUIPMENT_ATTRS;

  // 1. Plant information present.
  if (!model.plantInformation.originatingSystem && !model.plantInformation.schemaVersion) {
    issues.push(
      issue(
        'warning',
        'DEXPI001',
        'PlantInformation is missing both OriginatingSystem and SchemaVersion.',
        'PlantModel/PlantInformation',
      ),
    );
  }

  // 2. Duplicate IDs across the whole model.
  const seen = new Map<string, number>();
  const allNodes: DexpiNode[] = [
    ...model.equipment,
    ...model.equipment.flatMap((e) => e.nozzles),
    ...model.segments,
    ...model.instrumentation,
  ];
  for (const node of allNodes) {
    if (node.id) {
      seen.set(node.id, (seen.get(node.id) ?? 0) + 1);
    }
  }
  for (const [id, count] of seen) {
    if (count > 1) {
      issues.push(
        issue(
          'error',
          'DEXPI002',
          `Duplicate ID "${id}" used by ${count} elements.`,
          'PlantModel',
          id,
        ),
      );
    }
  }

  // 3. Equipment required attributes + presence of position.
  model.equipment.forEach((eq, i) => {
    const path = `PlantModel/Equipment[${i}]`;
    for (const attr of required) {
      if (!eq.attributes[attr]) {
        issues.push(
          issue(
            'error',
            'DEXPI003',
            `Equipment is missing the required attribute "${attr}".`,
            path,
            eq.id,
          ),
        );
      }
    }
    if (!eq.position) {
      issues.push(
        issue(
          'warning',
          'DEXPI004',
          'Equipment has no resolvable Position/Location; it cannot be drawn.',
          path,
          eq.id,
        ),
      );
    }
    eq.nozzles.forEach((nozzle, j) => {
      if (!nozzle.id) {
        issues.push(
          issue(
            'warning',
            'DEXPI005',
            'Nozzle has no ID and cannot be referenced by piping.',
            `${path}/Nozzle[${j}]`,
          ),
        );
      }
    });
  });

  // 4. Segment connections resolve to a known node.
  model.segments.forEach((segment, i) => {
    const path = `PlantModel/PipingNetworkSegment[${i}]`;
    if (segment.connections.length === 0) {
      issues.push(
        issue(
          'info',
          'DEXPI006',
          'PipingNetworkSegment has no Connection elements.',
          path,
          segment.id,
        ),
      );
    }
    segment.connections.forEach((conn, j) => {
      for (const [end, ref] of [
        ['FromID', conn.fromId],
        ['ToID', conn.toId],
      ] as const) {
        if (ref === undefined) {
          issues.push(
            issue(
              'warning',
              'DEXPI007',
              `Connection is missing ${end}; the segment end is dangling.`,
              `${path}/Connection[${j}]`,
              segment.id,
            ),
          );
        } else if (!model.index[ref]) {
          issues.push(
            issue(
              'error',
              'DEXPI008',
              `Connection ${end}="${ref}" does not resolve to any element in the model.`,
              `${path}/Connection[${j}]`,
              segment.id,
            ),
          );
        }
      }
    });
  });

  return issues;
}

export function summarize(issues: ValidationIssue[]): {
  errors: number;
  warnings: number;
  info: number;
} {
  return {
    errors: issues.filter((i) => i.severity === 'error').length,
    warnings: issues.filter((i) => i.severity === 'warning').length,
    info: issues.filter((i) => i.severity === 'info').length,
  };
}
