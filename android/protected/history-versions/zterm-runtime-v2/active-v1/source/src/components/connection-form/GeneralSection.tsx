import { ConnectionSection, FieldLabel, TagList, inputStyle } from './ConnectionSection';

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
        <input value={name} onChange={(event) => onNameChange(event.target.value)} placeholder="例如：MacStudio" style={inputStyle()} />
      </div>

      <div>
        <FieldLabel>Tags</FieldLabel>
        <div style={{ display: 'flex', gap: '10px' }}>
          <input
            value={tagInput}
            onChange={(event) => onTagInputChange(event.target.value)}
            placeholder="例如：home-lab"
            style={inputStyle({ flex: 1 })}
          />
          <button type="button" onClick={onAddTag} style={{ ...inputStyle({ width: '96px' }), fontWeight: 700, cursor: 'pointer' }}>
            Add
          </button>
        </div>
        <div style={{ marginTop: '12px' }}>
          <TagList tags={tags} onRemove={onRemoveTag} />
        </div>
      </div>
    </ConnectionSection>
  );
}
