import { ConnectionSection, FieldLabel, TagList, inputStyle } from './ConnectionSection';
import { AmbientButton, AmbientInput } from '../ambient';

interface GeneralSectionProps {
  name: string;
  onNameChange: (value: string) => void;
  tagInput: string;
  onTagInputChange: (value: string) => void;
  onAddTag: () => void;
  tags: string[];
  onRemoveTag: (tag: string) => void;
}

export function GeneralSection({
  name,
  onNameChange,
  tagInput,
  onTagInputChange,
  onAddTag,
  tags,
  onRemoveTag,
}: GeneralSectionProps) {
  return (
    <ConnectionSection title="General" description="Basic identity and grouping for this connection.">
      <div>
        <FieldLabel>Name *</FieldLabel>
        <AmbientInput value={name} onChange={(event) => onNameChange(event.target.value)} placeholder="例如：MacStudio" style={inputStyle()} />
      </div>

      <div>
        <FieldLabel>Tags</FieldLabel>
        <div style={{ display: 'flex', gap: '10px' }}>
          <AmbientInput
            value={tagInput}
            onChange={(event) => onTagInputChange(event.target.value)}
            placeholder="例如：home-lab"
            style={inputStyle({ flex: 1 })}
          />
          <AmbientButton type="button" onClick={onAddTag} style={{ ...inputStyle({ width: '96px' }), fontWeight: 700, cursor: 'pointer' }}>
            Add
          </AmbientButton>
        </div>
        <div style={{ marginTop: '12px' }}>
          <TagList tags={tags} onRemove={onRemoveTag} />
        </div>
      </div>
    </ConnectionSection>
  );
}
