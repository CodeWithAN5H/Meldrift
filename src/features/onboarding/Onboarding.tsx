import { useState } from 'react';
import { ArrowRight, ShieldCheck, Sparkles } from 'lucide-react';
import { useWorkspace } from '@/state/workspace';
import { MeldriftMark } from '@/icons/MeldriftMark';
import { Button, Field } from '@/components/ui';
import { AVATAR_COLORS, vars } from '@/lib/model';
import { DISPLAY_NAME_PLACEHOLDER } from '@/lib/profileText';
import './onboarding.css';

export function Onboarding() {
  const completeOnboarding = useWorkspace((state) => state.completeOnboarding);
  const [name, setName] = useState('');
  const [color, setColor] = useState<string>(AVATAR_COLORS[0]);
  const [busy, setBusy] = useState(false);

  const start = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await completeOnboarding(name, color);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="md-onboard">
      <div className="md-onboard__glow" aria-hidden="true" />
      <div className="md-onboard__card">
        <div className="md-onboard__brand">
          <MeldriftMark size={38} />
          <div>
            <p className="md-onboard__word">Meldrift</p>
            <p className="md-onboard__tag">Your game. Everyone's turn.</p>
          </div>
        </div>

        <div className="md-onboard__body">
          <span className="md-pill md-pill--accent">
            <Sparkles size={11} /> No account needed
          </span>
          <h1 className="md-onboard__title">Set up your player</h1>
          <p className="md-onboard__text">
            Pick the name your friends will see in rooms and chat. Your profile,
            rooms and messages stay on this PC.
          </p>

          <Field
            label="Display name"
            htmlFor="onboard-name"
            hint="Up to 32 characters. You can change this later in Settings."
          >
            <input
              id="onboard-name"
              className="md-input"
              value={name}
              maxLength={32}
              autoFocus
              placeholder={DISPLAY_NAME_PLACEHOLDER}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void start();
              }}
            />
          </Field>

          <Field label="Avatar colour">
            <div className="md-onboard__swatches">
              {AVATAR_COLORS.map((swatch) => (
                <button
                  key={swatch}
                  type="button"
                  className="md-swatch"
                  style={vars({ '--swatch': swatch })}
                  data-active={color === swatch}
                  aria-label={`Use ${swatch}`}
                  onClick={() => setColor(swatch)}
                />
              ))}
            </div>
          </Field>
        </div>

        <div className="md-onboard__foot">
          <p className="md-onboard__local">
            <ShieldCheck size={13} />
            Free forever. No ads, no subscriptions.
          </p>
          <Button
            variant="primary"
            disabled={!name.trim() || busy}
            onClick={() => void start()}
            icon={<ArrowRight size={15} />}
          >
            Enter Meldrift
          </Button>
        </div>
      </div>
    </div>
  );
}
