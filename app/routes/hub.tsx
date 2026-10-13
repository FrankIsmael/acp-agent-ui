/**
 * Hub — la pantalla de inicio: reloj grande, saludo, y el input centrado.
 * Enviar crea la conversación en el servidor y navega a /c/:id.
 */
import { useI18n } from '~/i18n';
import { demoEnabled } from '~/.server/demo';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { MainPanelLayout } from '~/components/Layout/MainPanelLayout';
import { ChatInputCard } from '~/components/ChatInputCard';
import { ChatInput } from '~/components/ChatInput';
import type { Route } from './+types/hub';
import {
  uploadFile,
  type ConfigOption,
  type PromptImage,
} from '~/hooks/useAcpStream';
import type { UploadedFile } from '~/lib/attachments';
import { readModelPreference } from '~/.server/model-preference';
import {
  config,
  getLastAttachmentSupport,
  getLastConfigOptions,
} from '~/.server/acp';
import { EMBED_PREFIX, useChatBase } from '~/lib/embed';

export async function loader({ request }: Route.LoaderArgs) {
  const preference = await readModelPreference(request);
  const options = demoEnabled() ? [] : getLastConfigOptions();
  const model = options.find(
    (option) => option.category === 'model' || option.id === 'model',
  );
  return {
    cwd: config.cwd,
    ...getLastAttachmentSupport(),
    model: model
      ? ({
          ...model,
          currentValue: preference ?? model.currentValue,
        } as ConfigOption)
      : null,
    preference,
  };
}

// Starter questions, similar to the Google Maps demo but focused on Mexico City. The first one
// uses all of Grounding Lite in one turn (route, forecast, and places to stay); the rest show that
// the agent can do more than maps: images, artifacts, and the `xlsx-gen` and `slides` skills.
const STARTERS = [
  'I want to go from Mexico City to Teotihuacán tomorrow. What is the best route and what is the weather forecast? How to sleep there?',
  'Generate an illustration of the Palacio de Bellas Artes at sunset',
  'Build a one-page itinerary for a weekend in Mexico City',
  'Make a spreadsheet with the budget for a 3-day trip to Mexico City',
  'Make a 5-slide deck about the best Mexico City neighborhoods to visit',
];

function useClock() {
  const [now, setNow] = useState<Date | null>(null);
  // Arranca en null: la hora del servidor no es la del usuario y provocaría
  // un desajuste de hidratación.
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);
  if (!now) return null;
  const hour = now.getHours();
  const displayHour = ((hour + 11) % 12) + 1;
  return {
    time: `${displayHour}:${String(now.getMinutes()).padStart(2, '0')}`,
    meridiem: hour >= 12 ? 'PM' : 'AM',
    hour,
  };
}

export default function Hub({
  loaderData,
}: {
  loaderData: {
    cwd: string;
    imageSupport: boolean;
    visionModels: string[];
    model: ConfigOption | null;
    preference: string | null;
  };
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const base = useChatBase();
  const embedded = base === EMBED_PREFIX;
  const clock = useClock();
  const [model, setModel] = useState(loaderData.model);
  const [configBusy, setConfigBusy] = useState<string | null>(null);
  useEffect(() => setModel(loaderData.model), [loaderData.model]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const greeting = !clock
    ? ''
    : clock.hour < 12
      ? t('Good morning')
      : clock.hour < 18
        ? t('Good afternoon')
        : t('Good evening');

  const chooseModel = async (_id: string, value: string) => {
    if (!model) return;
    setConfigBusy(model.id);
    setError(null);
    try {
      const response = await fetch('/api/model-preference', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value }),
      });
      const body = await response.json();
      if (!response.ok)
        throw new Error(body.error ?? t('Could not save the model.'));
      setModel({ ...model, currentValue: body.value });
    } catch (error) {
      setError(
        error instanceof Error ? error.message : t('Could not save the model.'),
      );
    } finally {
      setConfigBusy(null);
    }
  };

  // There is no conversation to upload to yet: documents wait here, keyed by a local id,
  // and go up once the conversation exists, right before navigating to it.
  const pending = useRef(new Map<string, File>());
  const holdFile = async (file: File): Promise<UploadedFile> => {
    const id = `local-${Math.random().toString(36).slice(2)}`;
    pending.current.set(id, file);
    return {
      id,
      name: file.name,
      mimeType: file.type || 'application/octet-stream',
      size: file.size,
    };
  };

  const handleSubmit = async (
    text: string,
    images: PromptImage[] = [],
    held: UploadedFile[] = [],
  ) => {
    if (creating || configBusy) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch('/api/conversations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(embedded ? { via: 'embed' } : {}),
      });
      const body = await res.json();
      if (!res.ok)
        throw new Error(body.error ?? t('could not open the conversation'));
      window.dispatchEvent(new Event('conversations-changed'));
      const files = await Promise.all(
        held.map((f) =>
          uploadFile(
            body.conversationId,
            pending.current.get(f.id)!,
            t('Could not upload {name}.', { name: f.name }),
          ),
        ),
      );
      pending.current.clear();
      navigate(`${base}/c/${encodeURIComponent(body.conversationId)}`, {
        state: { firstMessage: { text, images, files } },
      });
    } catch (e) {
      setError((e as Error).message);
      setCreating(false);
    }
  };

  return (
    <MainPanelLayout>
      <div className="relative flex h-full min-h-0 flex-col items-center justify-center px-4 sm:px-6">
        <div className="w-full max-w-2xl">
          <div className="mb-1 flex items-baseline gap-2">
            <span className="text-5xl font-light tabular-nums tracking-tight text-text-primary sm:text-6xl">
              {clock?.time ?? '—'}
            </span>
            <span className="text-2xl font-light text-text-secondary">
              {clock?.meridiem ?? ''}
            </span>
          </div>
          <p className="mb-6 text-xl text-text-secondary">{greeting}</p>

          <ChatInputCard>
            <ChatInput
              onSubmit={handleSubmit}
              busy={creating}
              disabled={!!configBusy}
              configOptions={model ? [model] : []}
              configBusy={configBusy}
              onConfigChange={chooseModel}
              workingDir={loaderData.cwd}
              imageSupport={loaderData.imageSupport}
              visionModels={loaderData.visionModels}
              fileSupport={!embedded}
              onUpload={holdFile}
              placeholder={t('Ask your agent something…')}
            />
          </ChatInputCard>

          {/* The starters are a demo of the full app; the embedded widget hides them. */}
          {!embedded && (
            <ul
              className="mt-4 flex flex-wrap gap-2"
              aria-label={t('Suggested questions')}
            >
              {STARTERS.map((starter) => (
                <li key={starter}>
                  <button
                    type="button"
                    onClick={() => handleSubmit(t(starter))}
                    disabled={creating || !!configBusy}
                    className="rounded-full cursor-pointer border border-border-inverse bg-background-inverse hover:bg-background-inverse/90 px-3 py-1.5 text-left text-xs text-text-inverse transition-colors hover:border-border-inverse hover:text-text-inverse disabled:opacity-50"
                  >
                    {t(starter)}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {!model && loaderData.preference && (
            <p className="mt-2 text-xs text-text-secondary">
              {t('Model:')} {loaderData.preference}
            </p>
          )}
          {error && <p className="mt-3 text-sm text-text-danger">{t(error)}</p>}
          {creating && (
            <p className="mt-3 text-sm text-text-secondary">
              {t(
                'Opening the conversation… this can take up to a minute if the box was asleep or extensions need to start.',
              )}
            </p>
          )}
        </div>
      </div>
    </MainPanelLayout>
  );
}
