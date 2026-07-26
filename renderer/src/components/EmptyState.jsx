export default function EmptyState({ message }) {
  return (
    <div className="empty-state">
      <p>{message || 'No data available.'}</p>
    </div>
  );
}
