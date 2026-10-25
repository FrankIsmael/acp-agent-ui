/**
 * The simulator page: 3D stage with a readout overlay and playback bar, and a side panel with the
 * job, the G-code, the results and loading. The 3D scene is loaded only in the browser.
 */
import { lazy, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router';
import { ArrowLeft, Pause, Play, RotateCcw, SkipForward, Route as PathIcon, Sparkles, Square, TriangleAlert } from 'lucide-react';
import { useI18n } from '~/i18n';
import { cn } from '~/lib/utils';
import { Player, SPEEDS } from '../player.ts';
import { buildTimeline, type Timeline } from '../sim/timeline.ts';
import { parseJob, type Job } from '../sim/job-schema.ts';
import { compareToProfile, partWeight, STEP_MM, weight } from '../sim/stock.ts';
import type { CameraView } from '../scene/LatheScene.tsx';
import { replyProse } from '../agent-reply.ts';
import dumbbell from '../examples/dumbbell.json';
import pulley from '../examples/pulley.json';

const LatheScene = lazy(() => import('../scene/LatheScene.tsx'));

export const EXAMPLES: { id: string; job: unknown }[] = [
  { id: 'dumbbell', job: dumbbell },
  { id: 'pulley', job: pulley },
];

type Tab = 'describe' | 'job' | 'gcode' | 'results' | 'load';
export type AgentAccess = 'ready' | 'locked' | 'invite' | 'unconfigured';

function usePlayer(player: Player) {
  useSyncExternalStore(player.subscribe, player.getVersion, () => 0);
  return player;
}

export function LatheApp({ agent }: { agent: AgentAccess }) {
  const { t } = useI18n();
  const [job, setJob] = useState<Job>(() => {
    const parsed = parseJob(dumbbell);
    if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
    return parsed.job;
  });
  const timeline = useMemo(() => buildTimeline(job), [job]);
  const player = useRef(new Player()).current;
  const autoplay = useRef(false);
  useEffect(() => {
    player.load(timeline);
    if (autoplay.current) player.play();
    autoplay.current = false;
  }, [player, timeline]);
  useEffect(() => () => player.pause(), [player]);
  // For poking at playback from the console while developing.
  useEffect(() => {
    if (import.meta.env.DEV) Object.assign(window, { lathe: { player, timeline } });
  }, [player, timeline]);

  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const [view, setView] = useState<CameraView>('operator');
  const [showPath, setShowPath] = useState(true);
  const [tab, setTab] = useState<Tab>(agent === 'ready' ? 'describe' : 'job');

  // Space plays and pauses, unless the user is typing.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.code !== 'Space' || /INPUT|TEXTAREA|SELECT|BUTTON/.test(target.tagName)) return;
      event.preventDefault();
      player.toggle();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [player]);

  const tabs: { id: Tab; label: string }[] = [
    { id: 'describe', label: t('Describe') },
    { id: 'job', label: t('Job') },
    { id: 'gcode', label: t('G-code') },
    { id: 'results', label: t('Results') },
    { id: 'load', label: t('Load') },
  ];

  return (
    <div className="flex h-dvh w-full flex-col bg-background-primary text-text-primary md:flex-row">
      <section className="relative h-[58dvh] min-h-0 flex-1 overflow-hidden bg-gradient-to-b from-background-secondary to-background-tertiary md:h-auto">
        {mounted && (
          <Suspense fallback={<StageMessage text={t('Loading the lathe…')} />}>
            <LatheScene timeline={timeline} player={player} view={view} showPath={showPath} />
          </Suspense>
        )}
        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-3">
          <div className="pointer-events-auto flex items-center gap-2">
            <Link to="/" className="rounded-md bg-background-primary/80 p-1.5 text-text-secondary backdrop-blur hover:text-text-primary" aria-label={t('Back to the hub')}>
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <Readout player={player} timeline={timeline} />
          </div>
          <StatusChip player={player} timeline={timeline} />
        </div>
        <div className="absolute right-3 top-14 flex flex-col gap-1">
          {(['operator', 'top', 'tool'] as CameraView[]).map((v) => (
            <button key={v} onClick={() => setView(v)}
              className={cn('rounded-md px-2 py-1 text-xs backdrop-blur', view === v ? 'bg-background-inverse text-text-inverse' : 'bg-background-primary/80 text-text-secondary hover:text-text-primary')}>
              {v === 'operator' ? t('Operator') : v === 'top' ? t('Top') : t('Tool')}
            </button>
          ))}
          <button onClick={() => setShowPath(!showPath)} title={t('Show toolpath')}
            className={cn('flex items-center justify-center rounded-md px-2 py-1 backdrop-blur', showPath ? 'bg-background-inverse text-text-inverse' : 'bg-background-primary/80 text-text-secondary')}>
            <PathIcon className="h-3.5 w-3.5" />
          </button>
        </div>
        <Controls player={player} timeline={timeline} />
      </section>

      <aside className="flex min-h-0 w-full flex-1 flex-col border-border-primary md:w-[380px] md:flex-none md:border-l">
        <header className="border-b border-border-primary px-4 py-3">
          <p className="text-xs uppercase tracking-wide text-text-tertiary">{t('Lathe simulator')}</p>
          <h1 className="truncate text-lg font-light">{job.name}</h1>
        </header>
        <nav className="flex border-b border-border-primary px-2">
          {tabs.map((item) => (
            <button key={item.id} onClick={() => setTab(item.id)}
              className={cn('-mb-px border-b-2 px-3 py-2 text-sm', tab === item.id ? 'border-text-primary text-text-primary' : 'border-transparent text-text-tertiary hover:text-text-secondary')}>
              {item.label}
            </button>
          ))}
        </nav>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* Kept mounted so a running request and its reply survive switching tabs. */}
          <div className={tab === 'describe' ? undefined : 'hidden'}>
            <DescribePanel agent={agent} job={job} onJob={(next) => { autoplay.current = true; setJob(next); }} />
          </div>
          {tab === 'job' && <JobPanel job={job} timeline={timeline} player={player} />}
          {tab === 'gcode' && <GcodePanel job={job} timeline={timeline} player={player} onChange={setJob} />}
          {tab === 'results' && <ResultsPanel timeline={timeline} player={player} />}
          {tab === 'load' && <LoadPanel onLoad={(next) => { setJob(next); setTab('job'); }} />}
        </div>
      </aside>
    </div>
  );
}

function StageMessage({ text }: { text: string }) {
  return <div className="flex h-full items-center justify-center text-sm text-text-tertiary">{text}</div>;
}

const fmt = (value: number, digits = 3) => value.toFixed(digits).replace('-', '−');
const clock = (seconds: number) => {
  const m = Math.floor(seconds / 60), s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};

function Readout({ player, timeline }: { player: Player; timeline: Timeline }) {
  usePlayer(player);
  const s = timeline.stateAt(player.t);
  const feed = s.kind === 'feed' ? (s.perRev ? fmt(s.feedWord, 2) : fmt(s.feed, 0)) : '—';
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-0.5 rounded-md bg-neutral-950/80 px-3 py-1.5 font-mono text-xs text-white backdrop-blur">
      <span>X Ø{fmt(s.pos.x)}</span>
      <span>Z {fmt(s.pos.z)}</span>
      <span>S {Math.round(s.rpm).toLocaleString('en-US')}</span>
      <span>F {feed}</span>
      <span>T{String(s.tool).padStart(2, '0')}</span>
      {s.coolant && <span className="text-blue-100">M8</span>}
    </div>
  );
}

function StatusChip({ player, timeline }: { player: Player; timeline: Timeline }) {
  const { t } = useI18n();
  usePlayer(player);
  const done = player.t >= timeline.duration && timeline.duration > 0;
  const label = player.playing ? t('Running') : done ? t('Done') : player.t > 0 ? t('Paused') : t('Ready');
  return (
    <div className="pointer-events-auto flex items-center gap-1.5">
      {timeline.warnings.length > 0 && (
        <span className="flex items-center gap-1 rounded-full bg-background-warning px-2 py-0.5 text-xs text-text-warning" title={timeline.warnings.map((w) => `L${w.line}: ${w.message}`).join('\n')}>
          <TriangleAlert className="h-3 w-3" /> {timeline.warnings.length}
        </span>
      )}
      <span className={cn('rounded-full px-2.5 py-0.5 text-xs', player.playing ? 'bg-background-success text-text-success' : 'bg-background-primary/80 text-text-secondary')}>{label}</span>
    </div>
  );
}

/** Start and end time of each operation, from the segments on its lines. */
function operationTimes(timeline: Timeline) {
  return timeline.job.operations.map((op) => {
    let start = Infinity, end = 0;
    for (const s of timeline.segments)
      if (s.line >= op.lines[0] && s.line <= op.lines[1]) { start = Math.min(start, s.t0); end = Math.max(end, s.t0 + s.dt); }
    return { op, start: Number.isFinite(start) ? start : 0, end };
  });
}

function Controls({ player, timeline }: { player: Player; timeline: Timeline }) {
  const { t } = useI18n();
  usePlayer(player);
  const ops = useMemo(() => operationTimes(timeline), [timeline]);
  const duration = timeline.duration || 1;
  return (
    <div className="absolute inset-x-0 bottom-0 flex items-center gap-2 bg-background-primary/85 px-3 py-2 backdrop-blur">
      <button onClick={() => player.toggle()} className="rounded-md bg-background-inverse p-1.5 text-text-inverse" aria-label={player.playing ? t('Pause') : t('Play')}>
        {player.playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
      </button>
      <button onClick={() => player.stepLine()} className="rounded-md p-1.5 text-text-secondary hover:text-text-primary" title={t('Step one line')}>
        <SkipForward className="h-4 w-4" />
      </button>
      <button onClick={() => { player.pause(); player.seek(0); }} className="rounded-md p-1.5 text-text-secondary hover:text-text-primary" title={t('Restart')}>
        <RotateCcw className="h-4 w-4" />
      </button>
      <select value={player.speed} onChange={(e) => player.setSpeed(Number(e.target.value))} className="rounded-md border border-border-primary bg-background-primary px-1 py-1 text-xs" aria-label={t('Speed')}>
        {SPEEDS.map((speed) => <option key={speed} value={speed}>{speed}×</option>)}
      </select>
      <div className="relative mx-1 flex-1">
        <div className="pointer-events-none absolute inset-x-0 -top-1.5 h-1">
          {ops.map(({ op, start, end }, i) => (
            <div key={i} title={op.name} className={cn('absolute h-1 rounded-full', i % 2 ? 'bg-blue-200' : 'bg-block-teal')}
              style={{ left: `${(start / duration) * 100}%`, width: `${Math.max(0.5, ((end - start) / duration) * 100)}%` }} />
          ))}
        </div>
        <input type="range" min={0} max={duration} step={0.01} value={player.t} className="w-full accent-[var(--color-text-primary)]"
          onChange={(e) => { player.pause(); player.seek(Number(e.target.value)); }} aria-label={t('Timeline')} />
      </div>
      <span className="whitespace-nowrap font-mono text-xs text-text-secondary">{clock(player.t)} / {clock(timeline.duration)}</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-border-primary px-4 py-3">
      <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-text-tertiary">{title}</h2>
      {children}
    </section>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3 py-0.5 text-sm">
      <span className="text-text-secondary">{label}</span>
      <span className="text-right font-mono text-text-primary">{value}</span>
    </div>
  );
}

function JobPanel({ job, timeline, player }: { job: Job; timeline: Timeline; player: Player }) {
  const { t } = useI18n();
  usePlayer(player);
  const ops = useMemo(() => operationTimes(timeline), [timeline]);
  return (
    <>
      <Section title={t('Stock')}>
        <Row label={t('Material')} value={job.material.name} />
        <Row label={t('Bar')} value={`Ø${job.stock.diameter} × ${job.stock.length} mm`} />
        <Row label={t('Out of the chuck')} value={`${job.stock.stickout} mm`} />
      </Section>
      <Section title={t('Tools')}>
        {job.tools.map((tool) => (
          <Row key={tool.id} label={`T${String(tool.id).padStart(2, '0')} · ${tool.name}`}
            value={tool.type === 'parting' ? `${t('parting')} ${tool.width} mm` : `${tool.insert ?? ''} r${tool.noseRadius}`} />
        ))}
      </Section>
      <Section title={t('Operations')}>
        {ops.length === 0 && <p className="text-sm text-text-tertiary">{t('This job lists no operations.')}</p>}
        {ops.map(({ op, start, end }, i) => {
          const active = player.t >= start && player.t < end;
          return (
            <button key={i} onClick={() => player.seek(start)}
              className={cn('flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-background-secondary', active && 'bg-background-secondary')}>
              <span>{op.name} <span className="text-text-tertiary">· T{String(op.tool).padStart(2, '0')}</span></span>
              <span className="font-mono text-xs text-text-secondary">{clock(end - start)}</span>
            </button>
          );
        })}
      </Section>
      {job.assumptions.length > 0 && (
        <Section title={t('Assumptions')}>
          <ul className="list-disc space-y-1 pl-4 text-sm text-text-secondary">
            {job.assumptions.map((a, i) => <li key={i}>{a}</li>)}
          </ul>
        </Section>
      )}
    </>
  );
}

function GcodePanel({ job, timeline, player, onChange }: { job: Job; timeline: Timeline; player: Player; onChange: (job: Job) => void }) {
  const { t } = useI18n();
  usePlayer(player);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(job.gcode);
  useEffect(() => setDraft(job.gcode), [job.gcode]);
  const current = timeline.stateAt(player.t).line;
  const lines = useMemo(() => job.gcode.split(/\r?\n/), [job.gcode]);
  const warnings = useMemo(() => new Map(timeline.warnings.map((w) => [w.line, w.message])), [timeline]);
  const active = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (player.playing) active.current?.scrollIntoView({ block: 'nearest' });
  }, [current, player.playing]);

  if (editing)
    return (
      <div className="flex h-full flex-col gap-2 p-3">
        <textarea value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false}
          className="min-h-[300px] flex-1 rounded-md border border-border-primary bg-background-secondary p-2 font-mono text-xs" />
        <div className="flex justify-end gap-2">
          <button onClick={() => { setDraft(job.gcode); setEditing(false); }} className="rounded-md px-3 py-1.5 text-sm text-text-secondary">{t('Cancel')}</button>
          <button onClick={() => { onChange({ ...job, gcode: draft }); setEditing(false); }} className="rounded-md bg-background-inverse px-3 py-1.5 text-sm text-text-inverse">{t('Run again')}</button>
        </div>
      </div>
    );

  return (
    <div className="py-1">
      <div className="flex justify-end px-3 py-1">
        <button onClick={() => setEditing(true)} className="text-xs text-text-secondary underline-offset-2 hover:underline">{t('Edit')}</button>
      </div>
      <div className="font-mono text-xs">
        {lines.map((text, i) => {
          const line = i + 1;
          const start = timeline.lineStart.get(line);
          const warning = warnings.get(line);
          return (
            <div key={i} ref={line === current ? active : undefined}
              onClick={() => start !== undefined && player.seek(start)}
              title={warning}
              className={cn('flex gap-3 px-3 py-px', start !== undefined && 'cursor-pointer hover:bg-background-secondary', line === current && 'bg-background-inverse text-text-inverse', warning && line !== current && 'text-text-warning')}>
              <span className="w-6 shrink-0 text-right opacity-50">{line}</span>
              <span className="whitespace-pre">{text}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ResultsPanel({ timeline, player }: { timeline: Timeline; player: Player }) {
  const { t } = useI18n();
  usePlayer(player);
  const buffer = useMemo(() => new Float32Array(timeline.shape.n), [timeline]);
  const profile = timeline.profileAt(player.t, buffer);
  const now = weight(profile, timeline.shape.step, timeline.job.material.density);
  const target = useMemo(() => compareToProfile(timeline.final, timeline.shape, timeline.job.profile), [timeline]);
  const part = useMemo(() => partWeight(timeline.final, timeline.shape, timeline.job.profile, timeline.job.material.density), [timeline]);
  const kg = (g: number) => `${(g / 1000).toFixed(3)} kg`;
  return (
    <>
      <Section title={t('Weight')}>
        <Row label={t('Bar')} value={kg(timeline.startWeight)} />
        <Row label={t('Now')} value={kg(now)} />
        <Row label={t('Removed')} value={`${kg(timeline.startWeight - now)} (${(((timeline.startWeight - now) / timeline.startWeight) * 100).toFixed(1)} %)`} />
        {Number.isFinite(part) && <Row label={t('Finished part')} value={kg(part)} />}
      </Section>
      <Section title={t('Cycle time')}>
        <Row label={t('Total')} value={clock(timeline.duration)} />
        {operationTimes(timeline).map(({ op, start, end }, i) => <Row key={i} label={op.name} value={clock(end - start)} />)}
      </Section>
      {timeline.job.profile.length > 1 && (
        <Section title={t('Against the target profile')}>
          <Row label={t('Most stock left')} value={`${fmt(target.leftover * 2, 2)} mm Ø${Number.isNaN(target.leftoverZ) ? '' : ` @ Z${fmt(target.leftoverZ, 1)}`}`} />
          <Row label={t('Deepest gouge')} value={target.gouge > STEP_MM ? `${fmt(target.gouge * 2, 2)} mm Ø @ Z${fmt(target.gougeZ, 1)}` : t('none')} />
        </Section>
      )}
      <Section title={t('Warnings')}>
        {timeline.warnings.length === 0 ? <p className="text-sm text-text-tertiary">{t('none')}</p> : (
          <ul className="space-y-1 text-sm">
            {timeline.warnings.map((w, i) => (
              <li key={i} className="text-text-warning"><span className="font-mono text-xs text-text-tertiary">L{w.line}</span> {w.message}</li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}

/** Builds a job around plain G-code: a bar size and a generic turning tool for every T it uses. */
function jobFromGcode(gcode: string, stock: { diameter: number; length: number; stickout: number }): unknown {
  const ids = new Set<number>();
  for (const match of gcode.toUpperCase().matchAll(/T(\d+)/g)) {
    const value = Number(match[1]);
    ids.add(value >= 100 ? Math.floor(value / 100) : value);
  }
  if (!ids.size) ids.add(1);
  return {
    version: 1, name: 'Pasted program', material: { name: 'Steel', density: 7.85 },
    stock: { ...stock, faceStock: 1 },
    tools: [...ids].map((id) => ({ id, name: `Tool ${id}`, type: 'turning', noseRadius: 0.4, angle: 55, approach: 93 })),
    gcode,
  };
}

function LoadPanel({ onLoad }: { onLoad: (job: Job) => void }) {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [stock, setStock] = useState({ diameter: 50, length: 120, stickout: 90 });
  const isJson = text.trim().startsWith('{');

  const load = (input: unknown) => {
    const result = parseJob(input);
    if (result.ok) { setErrors([]); onLoad(result.job); }
    else setErrors(result.errors);
  };
  const run = () => {
    if (!text.trim()) return;
    if (!isJson) return load(jobFromGcode(text, stock));
    try { load(JSON.parse(text)); }
    catch (error) { setErrors([`${t('Not valid JSON')}: ${(error as Error).message}`]); }
  };

  return (
    <>
      <Section title={t('Examples')}>
        {EXAMPLES.map((example) => (
          <button key={example.id} onClick={() => load(example.job)} className="w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-background-secondary">
            {(example.job as { name: string }).name}
          </button>
        ))}
      </Section>
      <Section title={t('Paste a job or G-code')}>
        <textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} placeholder={t('A job JSON, or a G-code program')}
          className="h-48 w-full rounded-md border border-border-primary bg-background-secondary p-2 font-mono text-xs" />
        {!isJson && text.trim() && (
          <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
            {(['diameter', 'length', 'stickout'] as const).map((key) => (
              <label key={key} className="flex flex-col gap-1 text-text-secondary">
                {key === 'diameter' ? t('Bar Ø') : key === 'length' ? t('Length') : t('Out of the chuck')}
                <input type="number" min={1} value={stock[key]} onChange={(e) => setStock({ ...stock, [key]: Number(e.target.value) })}
                  className="rounded-md border border-border-primary bg-background-primary px-2 py-1 text-text-primary" />
              </label>
            ))}
          </div>
        )}
        <div className="mt-2 flex items-center justify-between gap-2">
          <label className="cursor-pointer text-xs text-text-secondary underline-offset-2 hover:underline">
            {t('Open a file…')}
            <input type="file" accept=".json,.nc,.txt,.gcode,.tap" className="hidden"
              onChange={async (e) => { const file = e.target.files?.[0]; if (file) setText(await file.text()); e.target.value = ''; }} />
          </label>
          <button onClick={run} disabled={!text.trim()} className="rounded-md bg-background-inverse px-3 py-1.5 text-sm text-text-inverse disabled:opacity-40">{t('Run')}</button>
        </div>
        {errors.length > 0 && (
          <ul className="mt-2 space-y-1 rounded-md bg-background-info p-2 font-mono text-xs text-text-primary">
            {errors.map((error, i) => <li key={i}>{error}</li>)}
          </ul>
        )}
      </Section>
    </>
  );
}

type AgentStatus = 'idle' | 'waking' | 'thinking' | 'writing' | 'fixing';

/** Reads `event:`/`data:` frames from a streamed response. */
async function* readEvents(response: Response) {
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += value;
    let end;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = frame.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
      if (data) yield JSON.parse(data);
    }
  }
}

function DescribePanel({ agent, job, onJob }: { agent: AgentAccess; job: Job; onJob: (job: Job) => void }) {
  const { t } = useI18n();
  const [prompt, setPrompt] = useState('');
  const [sessionId, setSessionId] = useState<string>();
  const [status, setStatus] = useState<AgentStatus>('idle');
  const [reply, setReply] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [asked, setAsked] = useState<string[]>([]);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  if (agent !== 'ready')
    return (
      <Section title={t('Describe the part')}>
        <p className="text-sm text-text-secondary">
          {agent === 'unconfigured'
            ? t('The lathe agent is not set up on the server. You can still load or paste a job.')
            : agent === 'invite'
            ? t('The lathe agent is only for invited guests. You can still load or paste a job.')
            : t('Visit /lathe?key=<key> once to use the lathe agent from this browser. You can still load or paste a job.')}
        </p>
      </Section>
    );

  const busy = status !== 'idle';
  const generate = async () => {
    const text = prompt.trim();
    if (!text || busy) return;
    const controller = new AbortController();
    abort.current = controller;
    setStatus('thinking'); setReply(''); setErrors([]);
    setAsked((list) => [...list, text]); setPrompt('');
    try {
      const response = await fetch('/api/lathe/jobs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: text, sessionId, setup: { material: job.material, stock: job.stock, tools: job.tools } }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text();
        let message = body;
        try { message = JSON.parse(body).error ?? body; } catch {}
        throw new Error(message || response.statusText);
      }
      for await (const event of readEvents(response)) {
        if (event.type === 'status') setStatus(event.status);
        else if (event.type === 'session') setSessionId(event.sessionId);
        else if (event.type === 'text') setReply((r) => r + event.text);
        else if (event.type === 'job') onJob(event.job);
        else if (event.type === 'error') setErrors([event.message, ...(event.errors ?? [])]);
      }
    } catch (error) {
      if (!controller.signal.aborted) setErrors([(error as Error).message]);
    } finally {
      setStatus('idle');
      abort.current = null;
    }
  };

  // While the job block is still streaming, show only the prose around it.
  const open = reply.lastIndexOf('```lathe-job');
  const streamingBlock = open >= 0 && reply.indexOf('```', open + 3) < 0;
  const prose = replyProse(streamingBlock ? reply.slice(0, open) : reply);
  const STATUS: Record<AgentStatus, string> = {
    idle: '', waking: t('Waking the agent…'), thinking: t('Thinking…'), writing: t('Writing the job…'), fixing: t('Fixing the job…'),
  };

  return (
    <>
      <Section title={sessionId ? t('Ask for a change') : t('Describe the part')}>
        {asked.length > 0 && (
          <ul className="mb-2 space-y-1">
            {asked.map((a, i) => <li key={i} className="rounded-md bg-background-secondary px-2 py-1 text-sm text-text-secondary">{a}</li>)}
          </ul>
        )}
        <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} disabled={busy}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void generate(); }}
          placeholder={sessionId ? t('Make the roughing passes 1.5 mm…') : t('A steel dumbbell handle, 30 mm grip, from 60 mm bar')}
          className="h-24 w-full rounded-md border border-border-primary bg-background-secondary p-2 text-sm disabled:opacity-60" />
        <div className="mt-2 flex items-center justify-between gap-2">
          {sessionId && !busy ? (
            <button onClick={() => { setSessionId(undefined); setAsked([]); setReply(''); setErrors([]); }} className="text-xs text-text-secondary underline-offset-2 hover:underline">{t('New part')}</button>
          ) : <span className="text-xs text-text-tertiary">{STATUS[status]}</span>}
          {busy ? (
            <button onClick={() => abort.current?.abort()} className="flex items-center gap-1.5 rounded-md border border-border-primary px-3 py-1.5 text-sm">
              <Square className="h-3.5 w-3.5" /> {t('Stop')}
            </button>
          ) : (
            <button onClick={generate} disabled={!prompt.trim()} className="flex items-center gap-1.5 rounded-md bg-background-inverse px-3 py-1.5 text-sm text-text-inverse disabled:opacity-40">
              <Sparkles className="h-3.5 w-3.5" /> {t('Generate')}
            </button>
          )}
        </div>
      </Section>
      {(prose || streamingBlock) && (
        <Section title={t('Agent')}>
          <p className="whitespace-pre-wrap text-sm text-text-secondary">{prose}</p>
          {streamingBlock && <p className="mt-2 text-xs text-text-tertiary">{t('Writing the job…')}</p>}
        </Section>
      )}
      {errors.length > 0 && (
        <Section title={t('Problems')}>
          <ul className="space-y-1 rounded-md bg-background-secondary p-2 font-mono text-xs text-text-danger">
            {errors.map((error, i) => <li key={i}>{error}</li>)}
          </ul>
        </Section>
      )}
    </>
  );
}
