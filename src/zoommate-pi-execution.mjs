import { Container, Text, stripTerminalSequences } from '@earendil-works/pi-tui';
import { ToolExecutionComponent } from '@earendil-works/pi-coding-agent';

const clean = value => stripTerminalSequences(String(value ?? '')).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, '');
const line = value => clean(value).replace(/\s+/gu, ' ').trim();
const format = value => clean(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
const succeeded = new Set(['completed', 'complete', 'done', 'success', 'succeeded']);
const failed = new Set(['failed', 'failure', 'error', 'cancelled', 'canceled', 'rejected']);
const running = new Set(['start', 'running', 'working', 'in_progress']);
const statusOf = value => String(value ?? '').toLowerCase();
const toolError = tool => Boolean(tool.error) || tool.responseType === 'error' || failed.has(statusOf(tool.status));
const keyOf = tool => `${tool.requestId ?? ''}:${tool.toolCallId ?? `${tool.messageId}:${tool.partId}`}`;
function toolStatus(tool) {
  if (toolError(tool)) return line(tool.status ?? 'failed');
  if (tool.isTerminal) return line(tool.status ?? 'result received');
  if (!tool.isActive) return 'outcome unreported';
  if (running.has(statusOf(tool.status))) return 'running';
  return line(tool.status ?? 'requested');
}
const toolRenderers = {
  renderCall({ native: tool }, theme) {
    const color = toolError(tool) ? 'error' : tool.isActive ? 'accent' : 'muted';
    return new Text(`${theme.bold(theme.fg('accent', line(tool.toolId ?? tool.type)))}  ${theme.fg(color, toolStatus(tool))}`, 0, 0);
  },
  renderResult(result, options, theme) {
    const tool = result.details, rows = [];
    if (tool.brief ?? tool.description) rows.push(line(tool.brief ?? tool.description));
    const output = tool.output ?? tool.result;
    if (options.expanded) {
      if (tool.args !== undefined || tool.input !== undefined) rows.push('Arguments', format(tool.args ?? tool.input));
      if (output !== undefined) rows.push('Native output', format(output));
      if (tool.error) rows.push('Native error', format(tool.error));
      rows.push(`Request: ${line(tool.requestId ?? 'not reported')} · Tool call: ${line(tool.toolCallId ?? 'not reported')}`);
    } else if (output !== undefined) rows.push(theme.fg('dim', 'Native output available · Ctrl+O details'));
    if (!tool.isActive && !tool.isTerminal) rows.push(theme.fg('warning', 'No terminal tool result was reported.'));
    return new Text(rows.join('\n'), 0, 0);
  },
};

class RemoteToolComponent extends ToolExecutionComponent {
  constructor(tool, { ui, cwd = process.cwd(), expanded = false }) {
    super(line(tool.toolId ?? tool.type), tool.toolCallId ?? keyOf(tool), { native: tool }, { showImages: false }, toolRenderers, ui, cwd);
    this.setExpanded(expanded);
    this.setNative(tool);
  }
  setNative(tool) {
    const signature = JSON.stringify(tool);
    if (signature === this.nativeSignature) return;
    this.nativeSignature = signature;
    this.updateArgs({ native: tool });
    this.setArgsComplete();
    if (tool.isActive || tool.isTerminal) this.markExecutionStarted();
    // This is display state only. No tool definition is registered or executed.
    this.updateResult({ content: [], details: tool, isError: toolError(tool) }, Boolean(tool.isActive));
  }
}
export const createZoomMateToolComponent = (tool, options = {}) => new RemoteToolComponent(tool, { ui: { requestRender() {} }, ...options });

function planText(plan, theme) {
  const complete = plan.filter(step => succeeded.has(statusOf(step.status))).length;
  const rows = [theme.fg('accent', `Plan · ${complete}/${plan.length} complete`)];
  for (const step of plan) {
    const status = statusOf(step.status);
    const mark = succeeded.has(status) ? '[x]' : failed.has(status) ? '[!]' : running.has(status) ? '[>]' : status === 'pending' ? '[ ]' : '[?]';
    const color = succeeded.has(status) ? 'success' : failed.has(status) ? 'error' : running.has(status) ? 'accent' : 'muted';
    rows.push(theme.fg(color, `${mark} ${line(step.title ?? step.stepId)}${status && !['completed', 'in_progress', 'pending'].includes(status) ? ` · ${line(step.status)}` : ''}`));
  }
  return rows.join('\n');
}

export class ZoomMateExecutionWidget extends Container {
  constructor(execution, requestId, ui, cwd, theme) {
    super(); this.ui = ui; this.cwd = cwd; this.theme = theme; this.expanded = false; this.tools = new Map();
    this.plan = new Text('', 0, 0); this.heading = new Text('', 0, 0);
    this.setExecution(execution, requestId);
  }
  setExpanded(expanded) { this.expanded = expanded; this.setExecution(this.execution, this.requestId); }
  setExecution(execution, requestId) {
    this.execution = execution; this.requestId = requestId;
    const steps = (execution.plan ?? []).filter(step => step.requestId === requestId);
    const tools = (execution.tools ?? []).filter(tool => tool.requestId === requestId);
    const visible = this.expanded ? tools : tools.slice(-3), retained = new Set(visible.map(keyOf));
    for (const key of this.tools.keys()) if (!retained.has(key)) this.tools.delete(key);
    this.children = [];
    this.heading.setText(this.theme.fg('accent', `Cloud execution${tools.length ? ` · ${tools.length} tool call${tools.length === 1 ? '' : 's'}` : ''}`)
      + this.theme.fg('dim', ' · Ctrl+O details'));
    this.addChild(this.heading);
    if (steps.length) { this.plan.setText(planText(steps, this.theme)); this.addChild(this.plan); }
    for (const tool of visible) {
      const key = keyOf(tool);
      let component = this.tools.get(key);
      if (!component) { component = createZoomMateToolComponent(tool, { ui: this.ui, cwd: this.cwd, expanded: this.expanded }); this.tools.set(key, component); }
      else { component.setNative(tool); component.setExpanded(this.expanded); }
      this.addChild(component);
    }
  }
}

export function renderZoomMateTool(message, options) {
  return createZoomMateToolComponent(message.details, { expanded: Boolean(options?.expanded) });
}
export function renderZoomMatePlan(message, _options, theme) {
  return new Text(planText(message.details.plan, theme), 1, 0);
}
