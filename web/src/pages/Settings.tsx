// Settings: how the app looks and answers on this device (lib/preferences.ts),
// who is signed in, and, for the site's operator, the accounts. Every choice
// takes effect as it is made; there is nothing to save.
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../lib/api.ts';
import { useSession } from '../lib/auth.ts';
import {
  type Preferences,
  setPreferences,
  usePreferences,
} from '../lib/preferences.ts';
import { signOut } from '../shell/sign-out.ts';
import './groups.css';
import './settings.css';

type Choice<K extends keyof Preferences> = {
  value: Preferences[K];
  label: string;
};

function Setting<K extends keyof Preferences>({
  name,
  title,
  hint,
  choices,
  value,
}: {
  name: K;
  title: string;
  hint: string;
  choices: Choice<K>[];
  value: Preferences[K];
}) {
  return (
    <div className="settings-row">
      <div className="settings-copy">
        <span className="settings-title" id={`setting-${name}`}>
          {title}
        </span>
        <span className="settings-hint">{hint}</span>
      </div>
      <div
        className="segmented"
        role="radiogroup"
        aria-labelledby={`setting-${name}`}
      >
        {choices.map((c) => (
          <label key={c.value}>
            <input
              type="radio"
              name={`setting-${name}`}
              checked={value === c.value}
              data-testid={`setting-${name}-${c.value}`}
              onChange={() =>
                setPreferences({ [name]: c.value } as Partial<Preferences>)
              }
            />
            {c.label}
          </label>
        ))}
      </div>
    </div>
  );
}

export function Settings() {
  const prefs = usePreferences();
  const { data: session } = useSession();
  const [operator, setOperator] = useState(false);
  useEffect(() => {
    let live = true;
    void api
      .isOperator()
      .then((yes) => {
        if (live) setOperator(yes);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  return (
    <main
      className="page groups-home settings-page"
      data-testid="settings-page"
    >
      <header className="groups-heading">
        <div>
          <div className="groups-eyebrow">DIGSITE / SETTINGS</div>
          <h1>Settings</h1>
          <p>How digsite looks and answers on this device.</p>
        </div>
      </header>

      <section className="settings-section" aria-labelledby="settings-look">
        <h2 id="settings-look">Appearance</h2>
        <Setting
          name="theme"
          title="Theme"
          hint="System follows this device's light or dark setting."
          value={prefs.theme}
          choices={[
            { value: 'system', label: 'System' },
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ]}
        />
        <Setting
          name="motion"
          title="Motion"
          hint="Reduce stops panels sliding and fading in."
          value={prefs.motion}
          choices={[
            { value: 'system', label: 'System' },
            { value: 'reduce', label: 'Reduce' },
          ]}
        />
      </section>

      <section className="settings-section" aria-labelledby="settings-sheets">
        <h2 id="settings-sheets">Sheets</h2>
        <Setting
          name="wheel"
          title="Mouse wheel"
          hint={
            prefs.wheel === 'zoom'
              ? 'Zooms about the pointer, as on the board. Shift+wheel pans.'
              : 'Scrolls the sheet. Ctrl+wheel or a pinch zooms.'
          }
          value={prefs.wheel}
          choices={[
            { value: 'zoom', label: 'Zooms' },
            { value: 'scroll', label: 'Scrolls' },
          ]}
        />
      </section>

      <section className="settings-section" aria-labelledby="settings-account">
        <h2 id="settings-account">Account</h2>
        <div className="settings-row">
          <div className="settings-copy">
            <span className="settings-title">
              {session?.user.name || session?.user.email || 'Signed in'}
            </span>
            <span className="settings-hint">{session?.user.email}</span>
          </div>
          <button
            type="button"
            data-testid="settings-sign-out"
            onClick={() => void signOut()}
          >
            Sign out
          </button>
        </div>
        {operator && (
          <div className="settings-row">
            <div className="settings-copy">
              <span className="settings-title">Accounts</span>
              <span className="settings-hint">
                Everyone who can sign in to this site. You run it.
              </span>
            </div>
            <Link
              className="settings-link"
              to="/settings/accounts"
              data-testid="settings-accounts"
            >
              Open
            </Link>
          </div>
        )}
      </section>
    </main>
  );
}
