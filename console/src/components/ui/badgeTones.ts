export type BadgeTone =
  | 'green' | 'cyan' | 'red' | 'rose' | 'amber'
  | 'blue' | 'slate' | 'violet' | 'orange';

export function severityTone(sev: string): BadgeTone {
  switch (sev) {
    case 'critical': return 'red';
    case 'high': return 'orange';
    case 'medium': return 'amber';
    case 'low': return 'blue';
    default: return 'slate';
  }
}

export function riskTone(risk: string): BadgeTone {
  switch (risk) {
    case 'exploit': return 'red';
    case 'credential': return 'red';
    case 'intrusive': return 'amber';
    default: return 'slate';
  }
}

export function statusTone(status: string): BadgeTone {
  switch (status) {
    case 'running': return 'green';
    case 'done': return 'blue';
    case 'partial': return 'amber';
    case 'failed': return 'red';
    case 'no-result': return 'slate';
    default: return 'slate';
  }
}
