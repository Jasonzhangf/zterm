import { ConnectionSection, FieldLabel, inputStyle } from './ConnectionSection';

interface AuthSectionProps {
  sessionName: string;
  onSessionNameChange: (value: string) => void;
}

export function AuthSection({
  sessionName,
  onSessionNameChange,
}: AuthSectionProps) {
  return (
    <ConnectionSection title="Tmux Session" description="Optional tmux session name. Leave empty to fall back to the connection name.">
      <div>
        <FieldLabel>Session Name</FieldLabel>
        <input value={sessionName} onChange={(event) => onSessionNameChange(event.target.value)} placeholder="例如：fin" style={inputStyle()} />
      </div>
    </ConnectionSection>
  );
}
