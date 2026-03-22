const API_BASE = '/api';

const elProgressText = document.getElementById('progress-text');
const elProgressFill = document.getElementById('progress-fill');
const elCardName = document.getElementById('card-name');
const elCardMeta = document.getElementById('card-meta');
const elBtnSkip = document.getElementById('btn-skip');
const elStatusMessage = document.getElementById('status-message');
const elOptionsGrid = document.getElementById('options-grid');
const elRelatedSection = document.getElementById('related-section');
const elRelatedGrid = document.getElementById('related-grid');
const elRelatedCount = document.getElementById('related-count');

let currentState = null;
let isProcessing = false;
let selectedRelatedIds = new Set();

async function init() {
    elBtnSkip.addEventListener('click', handleSkip);
    await fetchState();
}

async function fetchState() {
    try {
        setStatus('Loading queue...');
        const response = await fetch(`${API_BASE}/state`);
        if (!response.ok) throw new Error('Failed to fetch state');
        
        const state = await response.json();
        currentState = state;
        renderState(state);
        if (!state?.currentCard?.previewWarning) {
            setStatus('');
        }
    } catch (error) {
        console.error(error);
        setStatus('Error connecting to local server. Is it running?', true);
        elBtnSkip.disabled = true;
    }
}

function renderState(state) {
    if (!state || state.status === 'done' || !state.currentCard) {
        renderDone();
        return;
    }

    const { progress, currentCard } = state;

    if (progress) {
        elProgressText.textContent = `${progress.current} / ${progress.total}`;
        const percent = (progress.current / progress.total) * 100;
        elProgressFill.style.width = `${percent}%`;
    }

    elCardName.textContent = currentCard.name;
    elCardMeta.textContent = `${currentCard.options?.length || 0} full-card prints found`;
    if (currentCard.previewWarning) {
        setStatus(currentCard.previewWarning, true);
    }
    
    elBtnSkip.disabled = false;

    elOptionsGrid.innerHTML = '';
    if (elRelatedGrid) elRelatedGrid.innerHTML = '';
    selectedRelatedIds.clear();
    if (elRelatedCount) elRelatedCount.textContent = '0 selected';
    
    if (!currentCard.options || currentCard.options.length === 0) {
        elOptionsGrid.innerHTML = '<div class="empty-state">No PNG print options found for this card.</div>';
        if (elRelatedSection) elRelatedSection.style.display = 'none';
        return;
    }

    currentCard.options.forEach(option => {
        const cardEl = document.createElement('div');
        cardEl.className = 'art-option';
        cardEl.onclick = () => handleSelect(option.id);

        const isDoubleSided = option.isDoubleSided || option.layout === 'transform' || option.layout === 'modal_dfc';
        
        cardEl.innerHTML = `
            <div class="art-image-wrapper">
                ${isDoubleSided ? '<div class="badge-dsf">Double-Sided</div>' : ''}
                <img src="${option.imageUrl}" alt="${option.label || 'Card Art'}" class="art-image" loading="lazy" onerror="this.src='data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMDAlIiBoZWlnaHQ9IjEwMCUiPjxyZWN0IHdpZHRoPSIxMDAlIiBoZWlnaHQ9IjEwMCUiIGZpbGw9IiNlMGRmZDUiLz48dGV4dCB4PSI1MCUiIHk9IjUwJSIgZm9udC1mYW1pbHk9InNhbnMtc2VyaWYiIGZvbnQtc2l6ZT0iMTQiIGZpbGw9IiM1NSIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZHk9Ii4zZW0iPkltYWdlIE5vdCBGb3VuZDwvdGV4dD48L3N2Zz4='">
                <div class="selection-overlay"></div>
            </div>
            <div class="art-meta">
                <div class="art-set">${option.setName || 'Unknown Set'}</div>
                <div class="art-date">${option.setCode?.toUpperCase() || 'UNK'} ${option.collectorNumber || ''}${option.promo ? ' | Promo' : ''}</div>
                <div class="art-artist">${option.artist || 'Unknown Artist'}</div>
                ${option.releasedAt ? `<div class="art-date">${option.releasedAt}</div>` : ''}
                ${option.finishes && option.finishes.length ? `<div class="art-date">${option.finishes.join(', ')}</div>` : ''}
                ${option.imageUrls && option.imageUrls.length > 1 ? `<div class="art-date">${option.imageUrls.length} face previews in download</div>` : ''}
                ${isDoubleSided ? '<div class="dsf-notice">Saves to separate folder</div>' : '<div class="dsf-notice">PNG full-card image</div>'}
            </div>
        `;
        
        elOptionsGrid.appendChild(cardEl);
    });

    if (currentCard.relatedOptions && currentCard.relatedOptions.length > 0) {
        if (elRelatedSection) elRelatedSection.style.display = 'block';
        currentCard.relatedOptions.forEach(option => {
            const cardEl = document.createElement('div');
            cardEl.className = 'art-option related-option';
            cardEl.onclick = () => toggleRelated(option.id, cardEl);

            const isMultiFace = option.isMultiFace;
            const isDuplicate = option.alreadySelectedBy && option.alreadySelectedBy.length > 0;
            const duplicateText = isDuplicate ? `Already selected for: ${option.alreadySelectedBy.join(', ')}` : '';
            
            cardEl.innerHTML = `
                <div class="art-image-wrapper">
                    <div class="badge-selected">Selected</div>
                    ${isMultiFace ? '<div class="badge-dsf">Multi-Face</div>' : ''}
                    ${isDuplicate ? `<div class="badge-duplicate" title="${duplicateText}">Already Selected</div>` : ''}
                    <img src="${option.imageUrl}" alt="${option.label || 'Related Card'}" class="art-image" loading="lazy" onerror="this.src='data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMDAlIiBoZWlnaHQ9IjEwMCUiPjxyZWN0IHdpZHRoPSIxMDAlIiBoZWlnaHQ9IjEwMCUiIGZpbGw9IiNlMGRmZDUiLz48dGV4dCB4PSI1MCUiIHk9IjUwJSIgZm9udC1mYW1pbHk9InNhbnMtc2VyaWYiIGZvbnQtc2l6ZT0iMTQiIGZpbGw9IiM1NSIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZHk9Ii4zZW0iPkltYWdlIE5vdCBGb3VuZDwvdGV4dD48L3N2Zz4='">
                    <div class="selection-overlay"></div>
                </div>
                <div class="art-meta">
                    <div class="art-set">${option.label || option.setName || 'Unknown'}</div>
                    <div class="art-date">${option.setName || 'Unknown Set'} &bull; ${option.setCode?.toUpperCase() || 'UNK'} ${option.collectorNumber || ''}</div>
                    <div class="art-artist">${option.artist || 'Unknown Artist'}</div>
                    ${option.typeLine ? `<div class="art-date">${option.typeLine}</div>` : ''}
                    ${option.releasedAt ? `<div class="art-date">${option.releasedAt}</div>` : ''}
                    ${isDuplicate ? `<div class="dsf-notice">${duplicateText}</div>` : ''}
                </div>
            `;
            
            if (elRelatedGrid) elRelatedGrid.appendChild(cardEl);
        });
    } else {
        if (elRelatedSection) elRelatedSection.style.display = 'none';
    }
}

function toggleRelated(optionId, cardEl) {
    if (selectedRelatedIds.has(optionId)) {
        selectedRelatedIds.delete(optionId);
        cardEl.classList.remove('selected');
    } else {
        selectedRelatedIds.add(optionId);
        cardEl.classList.add('selected');
    }

    const count = selectedRelatedIds.size;
    if (elRelatedCount) {
        elRelatedCount.textContent = `${count} selected`;
    }
    
    if (count > 0) {
        setStatus(`${count} related add-on${count === 1 ? '' : 's'} selected`, false);
    } else if (!currentState?.currentCard?.previewWarning) {
        setStatus('');
    }
}

function renderDone() {
    elProgressText.textContent = 'Complete';
    elProgressFill.style.width = '100%';
    elCardName.textContent = 'Queue Finished';
    elCardMeta.textContent = 'All cards have been processed.';
    elBtnSkip.disabled = true;
    elOptionsGrid.innerHTML = '<div class="empty-state">The exhibition is complete.</div>';
    if (elRelatedSection) elRelatedSection.style.display = 'none';
}

async function handleSelect(optionId) {
    if (isProcessing || !currentState?.currentCard) return;
    isProcessing = true;
    
    const cards = document.querySelectorAll('.art-option');
    cards.forEach(c => c.style.pointerEvents = 'none');
    
    try {
        setStatus('Saving selection...');
        const response = await fetch(`${API_BASE}/select`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                cardName: currentState.currentCard.name,
                optionId: optionId,
                relatedIds: Array.from(selectedRelatedIds)
            })
        });
        
        if (!response.ok) throw new Error('Failed to save selection');
        
        await fetchState();
    } catch (error) {
        console.error(error);
        setStatus('Error saving selection. Try again.', true);
    } finally {
        isProcessing = false;
    }
}

async function handleSkip() {
    if (isProcessing || !currentState?.currentCard) return;
    isProcessing = true;
    
    try {
        setStatus('Skipping card...');
        const response = await fetch(`${API_BASE}/skip`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                cardName: currentState.currentCard.name
            })
        });
        
        if (!response.ok) throw new Error('Failed to skip card');
        
        await fetchState();
    } catch (error) {
        console.error(error);
        setStatus('Error skipping card. Try again.', true);
    } finally {
        isProcessing = false;
    }
}

function setStatus(message, isError = false) {
    elStatusMessage.textContent = message;
    if (isError) {
        elStatusMessage.classList.add('error');
    } else {
        elStatusMessage.classList.remove('error');
    }
}

document.addEventListener('DOMContentLoaded', init);
