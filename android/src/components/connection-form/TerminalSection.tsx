import { ConnectionSection, FieldLabel, inputStyle } from './ConnectionSection';

interface TerminalSectionProps {
  autoCommand: string;
  onAutoCommandChange: (value: string) => void;
}

export function TerminalSection({ autoCommand, onAutoCommandChange }: TerminalSectionProps) {
  return (
    <ConnectionSection title="Terminal" description="Commands to run right after tmux becomes ready.">
      <div>
        <FieldLabel>Auto Command</FieldLabel>
        <input
          value={autoCommand}
          onChange={(event) => onAutoCommandChange(event.target.value)}
          placeholder="例如：tmux attach -t main"
          style={inputStyle()}
        />
      </div>
    </ConnectionSection>
  );
}
