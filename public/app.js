window.onload = () => {
    let model = document.querySelector('#model');
    let hammertime = new Hammer(window);
    let button = document.querySelector('#animationButton');  // Add this line
    let isPlaying = false;  // Add this line

    hammertime.get('pinch').set({ enable: true });
    hammertime.get('pan').set({ direction: Hammer.DIRECTION_HORIZONTAL });  // Only allow horizontal panning

    let scale = 0.5;  // Change this according to your model's initial scale
    let prevDeltaX = 0;
    let prevScale = 1;
    let userInteracted = false;

    hammertime.on('panstart', function(ev){
        prevDeltaX = ev.deltaX;
    });

    hammertime.on('panmove', function(ev) {
        if (!userInteracted) {
            document.querySelector('#instructions').style.display = 'none';
            userInteracted = true;
        }

        let changeInX = ev.deltaX - prevDeltaX;
        model.object3D.rotation.y += changeInX / 150;  // adjust rotation based on change in deltaX

        prevDeltaX = ev.deltaX; // remember the deltaX for the next event
    });

    hammertime.on('panend', function(ev){
        prevDeltaX = 0; // reset prevDeltaX when pan ends
    });

    hammertime.on('pinchstart', function(ev) {
        prevScale = ev.scale;
    });

    hammertime.on('pinch', function(ev) {
        if (!userInteracted) {
            document.querySelector('#instructions').style.display = 'none';
            userInteracted = true;
        }

        scale *= ev.scale / prevScale; // calculate the scale based on the change from the last event
        prevScale = ev.scale; // remember the scale for the next event
        scale = Math.max(0.01, Math.min(2, scale)); // Limit the scale to a range

        model.object3D.scale.set(scale, scale, scale);
    });

    // Add this code block
    button.addEventListener('click', function () {
        if (!isPlaying) {
            model.components['animation-mixer'].play();
            button.textContent = 'Pause Animation';
            isPlaying = true;
        } else {
            model.components['animation-mixer'].pause();
            button.textContent = 'Start Animation';
            isPlaying = false;
        }
    });
}
