// Quick fix: minimal Create Room handler using Firebase REST API
(function(){
  const firebaseDbUrl = 'https://margadarshi-85118-default-rtdb.firebaseio.com';

  function showToast(msg, color = '#2563eb'){
    const toast = document.createElement('div');
    toast.innerText = msg; Object.assign(toast.style,{position:'fixed',right:'20px',bottom:'20px',background:color,color:'#fff',padding:'10px 14px',borderRadius:'8px',zIndex:10000});
    document.body.appendChild(toast); setTimeout(()=>toast.remove(),2500);
  }

  function ensureUser(){
    let userId = localStorage.getItem('userId');
    let username = localStorage.getItem('username');
    if(!userId){ userId = 'user-'+Date.now(); localStorage.setItem('userId', userId); }
    if(!username){ username = prompt('Enter your display name') || 'User'; localStorage.setItem('username', username); }
    return { userId, username };
  }

  async function createRoomHandler(){
    const displayNameInput = document.getElementById('displayNameInput');
    if(!displayNameInput || !displayNameInput.value.trim()){ showToast('Enter display name', '#e11d48'); return; }
    const username = displayNameInput.value.trim();
    const { userId } = ensureUser();
    localStorage.setItem('username', username);

    const roomId = 'room'+Math.floor(Math.random()*9000+1000);
    const passcode = Math.floor(Math.random()*9000+1000).toString();

    const url = `${firebaseDbUrl}/rooms/${roomId}.json`;
    try{
      const resp = await fetch(url, { method: 'PUT', body: JSON.stringify({ passcode }) });
      if(!resp.ok) throw new Error('Failed to create room');
      showToast('✅ Room created: '+roomId,'#10b981');

      // Update UI like openRoom would
      const roomModal = document.getElementById('roomModal');
      const mainLayout = document.getElementById('mainLayout');
      const roomIdDisplay = document.getElementById('roomIdDisplay');
      const passcodeDisplay = document.getElementById('passcodeDisplay');
      const roomLinkDiv = document.getElementById('roomLinkDiv');

      if(roomModal) roomModal.classList.add('hidden');
      if(mainLayout) mainLayout.classList.remove('hidden');
      if(roomIdDisplay) roomIdDisplay.innerText = 'Room ID: ' + roomId;
      if(passcodeDisplay) passcodeDisplay.innerText = 'Passcode: ' + passcode;
      if(roomLinkDiv){
        const currentJoinLink = `${window.location.origin}${window.location.pathname}?roomId=${roomId}&passcode=${passcode}`;
        roomLinkDiv.innerHTML = `<b>Room Link:</b> <a href="${currentJoinLink}" target="_blank">Join Room</a> <button id="copyJoinLinkBtn">Copy Link</button>`;
        const copyBtn = document.getElementById('copyJoinLinkBtn');
        if(copyBtn) copyBtn.addEventListener('click', ()=> navigator.clipboard.writeText(currentJoinLink).then(()=>showToast('🔗 Room link copied!')));
      }

    }catch(err){ console.error(err); showToast('Failed to create room: '+err.message,'#e11d48'); }
  }

  window.addEventListener('DOMContentLoaded', ()=>{
    const btn = document.getElementById('createRoomBtn');
    if(btn) btn.addEventListener('click', createRoomHandler);
  });
})();
