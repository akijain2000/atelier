import { useEffect, useState } from 'react';

export default function ListingSelector({ selectedListing, onSelect }) {
  const [listings, setListings] = useState([]);

  useEffect(() => {
    fetch('/api/listings')
      .then((r) => r.json())
      .then((data) => {
        setListings(data);
        if (!selectedListing && data.length > 0) {
          onSelect(data[0].id);
        }
      })
      .catch(() => {});
  }, []);

  if (!listings.length) return null;

  return (
    <div className="listing-selector">
      <label className="listing-selector-label" htmlFor="listing-select">
        Property
      </label>
      <select
        id="listing-select"
        className="field-select listing-select"
        value={selectedListing || ''}
        onChange={(e) => onSelect(e.target.value)}
      >
        {listings.map((listing) => (
          <option key={listing.id} value={listing.id}>
            {listing.name}
          </option>
        ))}
      </select>
    </div>
  );
}
