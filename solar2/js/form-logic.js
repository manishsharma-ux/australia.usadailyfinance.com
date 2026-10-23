/**
 * Form Logic - Optimal Transnational Lead Form
 * 
 * Handles the FLIP logic from Commercial to Residential when user answers
 * "Yes, I Live There" to the LiveInBuilding question.
 * 
 * UPDATED: Now works for BOTH Own and Lease scenarios.
 * 
 * Flow:
 * - OwnOrLease = "Own" + LiveInBuilding = "Yes, I Live There" → FLIP to Residential (Own)
 * - OwnOrLease = "Lease" + LiveInBuilding = "Yes, I Live There" → FLIP to Residential (Rent)
 * - LiveInBuilding = "No, Business Only" + Lease → Continue to LengthOfLease
 * - LiveInBuilding = "No, Business Only" + Own → Continue to ProductType
 */

document.addEventListener('DOMContentLoaded', function() {
    
    /**
     * Update form based on OwnOrLease and LiveInBuilding selections
     * This flips Commercial customers to Residential if they live in the building
     */
    function updateFormBasedOnSelection() {
        var ownOrLeaseSelection = document.querySelector('input[name="OwnOrLease"]:checked') 
            ? document.querySelector('input[name="OwnOrLease"]:checked').value 
            : null;
        var liveInBuildingSelection = document.querySelector('input[name="LiveInBuilding"]:checked') 
            ? document.querySelector('input[name="LiveInBuilding"]:checked').value 
            : null;
        
        // Only proceed if LiveInBuilding has been answered
        if (liveInBuildingSelection) {
            
            // FLIP: If user lives in the building, they're residential regardless of Own/Lease
            if (liveInBuildingSelection === 'Yes, I Live There') {
                // Change CustomerType to Residential
                var residentialRadio = document.querySelector('input[name="CustomerType"][value="Residential"]');
                if (residentialRadio) {
                    residentialRadio.checked = true;
                }
                
                // Set Homeowner based on OwnOrLease value
                if (ownOrLeaseSelection === 'Own') {
                    // They own the building and live there → Homeowner = Own
                    var homeownerOwnRadio = document.querySelector('input[name="Homeowner"][value="Own"]');
                    if (homeownerOwnRadio) {
                        homeownerOwnRadio.checked = true;
                    }
                } else if (ownOrLeaseSelection === 'Lease') {
                    // They lease the building and live there → Homeowner = Rent
                    var homeownerRentRadio = document.querySelector('input[name="Homeowner"][value="Rent"]');
                    if (homeownerRentRadio) {
                        homeownerRentRadio.checked = true;
                    }
                }
                
                console.log('[Form Logic] FLIP: Commercial → Residential (OwnOrLease: ' + ownOrLeaseSelection + ')');
            }
        }
    }
    
    /**
     * Update the next path for LiveInBuilding "No, Business Only" option
     * - If Lease → next is LengthOfLease
     * - If Own → next is ProductType
     */
    function updateLiveInBuildingPath() {
        var ownOrLeaseSelection = document.querySelector('input[name="OwnOrLease"]:checked') 
            ? document.querySelector('input[name="OwnOrLease"]:checked').value 
            : null;
        
        var noBusinessOnlyOption = document.querySelector('#LiveInBuilding input[value="No, Business Only"]');
        
        if (noBusinessOnlyOption && ownOrLeaseSelection) {
            if (ownOrLeaseSelection === 'Lease') {
                // Lease + No, Business Only → Go to LengthOfLease
                noBusinessOnlyOption.setAttribute('data-next', '#LengthOfLease');
                console.log('[Form Logic] LiveInBuilding "No, Business Only" path → #LengthOfLease');
            } else {
                // Own + No, Business Only → Go to ProductType
                noBusinessOnlyOption.setAttribute('data-next', '#ProductType');
                console.log('[Form Logic] LiveInBuilding "No, Business Only" path → #ProductType');
            }
        }
    }
    
    // Listen for changes on OwnOrLease to update LiveInBuilding paths
    document.querySelectorAll('input[name="OwnOrLease"]').forEach(function(input) {
        input.addEventListener('change', function() {
            updateLiveInBuildingPath();
        });
    });
    
    // Listen for changes on LiveInBuilding to trigger the flip logic
    document.querySelectorAll('input[name="LiveInBuilding"]').forEach(function(input) {
        input.addEventListener('change', function() {
            updateFormBasedOnSelection();
        });
    });
    
    // Initial setup - in case values are pre-selected
    updateLiveInBuildingPath();
});
