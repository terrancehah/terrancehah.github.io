"use strict";
/*
 * ATTENTION: An "eval-source-map" devtool has been used.
 * This devtool is neither made for production nor for readable output files.
 * It uses "eval()" calls to create a separate source file with attached SourceMaps in the browser devtools.
 * If you are trying to read the output file, select a different devtool (https://webpack.js.org/configuration/devtool/)
 * or disable the default devtool with "devtool: false".
 * If you are looking for production-ready output files, see mode: "production" (https://webpack.js.org/configuration/mode/).
 */
self["webpackHotUpdate_N_E"]("pages/api/chat-update",{

/***/ "(middleware)/./pages/api/chat-update.ts":
/*!**********************************!*\
  !*** ./pages/api/chat-update.ts ***!
  \**********************************/
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

eval("__webpack_require__.r(__webpack_exports__);\n/* harmony export */ __webpack_require__.d(__webpack_exports__, {\n/* harmony export */   config: () => (/* binding */ config),\n/* harmony export */   \"default\": () => (/* binding */ handler)\n/* harmony export */ });\n/* harmony import */ var _ai_sdk_openai__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! @ai-sdk/openai */ \"(middleware)/./node_modules/@ai-sdk/openai/dist/index.mjs\");\n/* harmony import */ var ai__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ai */ \"(middleware)/./node_modules/ai/dist/index.mjs\");\n\n\n// Create an OpenAI instance with custom settings\nconst openai = (0,_ai_sdk_openai__WEBPACK_IMPORTED_MODULE_0__.createOpenAI)({\n    apiKey: process.env.OPENAI_API_KEY,\n    compatibility: \"strict\" // Important: use strict mode for OpenAI API\n});\n// Set the runtime configuration\nconst config = {\n    runtime: \"edge\",\n    regions: [\n        \"default\"\n    ]\n};\nasync function handler(req) {\n    if (req.method !== \"POST\") {\n        return new Response(\"Method not allowed\", {\n            status: 405\n        });\n    }\n    try {\n        console.log(\"[chat-update] Received request\");\n        const { messages, currentDetails, componentUpdate } = await req.json();\n        if (!messages || !Array.isArray(messages)) {\n            return new Response(JSON.stringify({\n                error: \"Invalid request: messages array is required\"\n            }), {\n                status: 400,\n                headers: {\n                    \"Content-Type\": \"application/json\",\n                    \"Access-Control-Allow-Origin\": \"*\",\n                    \"Access-Control-Allow-Methods\": \"POST, OPTIONS\",\n                    \"Access-Control-Allow-Headers\": \"Content-Type, Accept\"\n                }\n            });\n        }\n        if (!currentDetails) {\n            return new Response(JSON.stringify({\n                error: \"Invalid request: currentDetails is required\"\n            }), {\n                status: 400,\n                headers: {\n                    \"Content-Type\": \"application/json\",\n                    \"Access-Control-Allow-Origin\": \"*\",\n                    \"Access-Control-Allow-Methods\": \"POST, OPTIONS\",\n                    \"Access-Control-Allow-Headers\": \"Content-Type, Accept\"\n                }\n            });\n        }\n        const systemPrompt = componentUpdate ? `You are a travel assistant helping with a trip to ${currentDetails.destination}. \n        The user has just updated their ${componentUpdate.type}. \n        Simply acknowledge this update in a brief, friendly way.\n\n        Response Rules:\n        1. Keep response to 1 short sentence\n        2. Only acknowledge the change, do not make suggestions\n        3. If they update language preference, acknowledge that it affects the final PDF export language` : `You are a travel assistant helping with a trip to ${currentDetails.destination}.\n        Current Details:\n        - Dates: ${currentDetails.startDate} to ${currentDetails.endDate}\n        - Budget: ${currentDetails.budget}\n        - Preferences: ${currentDetails.preferences?.join(\", \")}\n        - Language: ${currentDetails.language} (for PDF export)\n\n        Response Rules:\n        1. Keep responses concise and relevant\n        2. Focus on answering user questions about their trip`;\n        const result = await (0,ai__WEBPACK_IMPORTED_MODULE_1__.streamText)({\n            model: openai(\"gpt--turbo\"),\n            messages: [\n                {\n                    role: \"system\",\n                    content: systemPrompt\n                },\n                ...messages\n            ],\n            maxTokens: 150,\n            temperature: 0.7\n        });\n        return new Response(result.textStream, {\n            headers: {\n                \"Content-Type\": \"text/event-stream\",\n                \"Cache-Control\": \"no-cache\",\n                \"Connection\": \"keep-alive\"\n            }\n        });\n    } catch (error) {\n        console.error(\"[chat-update] Error:\", error);\n        return new Response(JSON.stringify({\n            error: \"Internal server error\",\n            details: error.message\n        }), {\n            status: 500,\n            headers: {\n                \"Content-Type\": \"application/json\"\n            }\n        });\n    }\n}\n//# sourceURL=[module]\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiKG1pZGRsZXdhcmUpLy4vcGFnZXMvYXBpL2NoYXQtdXBkYXRlLnRzIiwibWFwcGluZ3MiOiI7Ozs7Ozs7QUFBOEM7QUFDZDtBQUdoQyxpREFBaUQ7QUFDakQsTUFBTUUsU0FBU0YsNERBQVlBLENBQUM7SUFDMUJHLFFBQVFDLFFBQVFDLEdBQUcsQ0FBQ0MsY0FBYztJQUNsQ0MsZUFBZSxTQUFVLDRDQUE0QztBQUN2RTtBQUVBLGdDQUFnQztBQUN6QixNQUFNQyxTQUFTO0lBQ3BCQyxTQUFTO0lBQ1RDLFNBQVM7UUFBQztLQUFVO0FBQ3RCLEVBQUU7QUFFYSxlQUFlQyxRQUFRQyxHQUFnQjtJQUNwRCxJQUFJQSxJQUFJQyxNQUFNLEtBQUssUUFBUTtRQUN6QixPQUFPLElBQUlDLFNBQVMsc0JBQXNCO1lBQUVDLFFBQVE7UUFBSTtJQUMxRDtJQUVBLElBQUk7UUFFRkMsUUFBUUMsR0FBRyxDQUFDO1FBRVosTUFBTSxFQUFFQyxRQUFRLEVBQUVDLGNBQWMsRUFBRUMsZUFBZSxFQUFFLEdBQUcsTUFBTVIsSUFBSVMsSUFBSTtRQUVwRSxJQUFJLENBQUNILFlBQVksQ0FBQ0ksTUFBTUMsT0FBTyxDQUFDTCxXQUFXO1lBQ3pDLE9BQU8sSUFBSUosU0FDVFUsS0FBS0MsU0FBUyxDQUFDO2dCQUFFQyxPQUFPO1lBQThDLElBQ3RFO2dCQUNFWCxRQUFRO2dCQUNSWSxTQUFTO29CQUNQLGdCQUFnQjtvQkFDaEIsK0JBQStCO29CQUMvQixnQ0FBZ0M7b0JBQ2hDLGdDQUFnQztnQkFDbEM7WUFDRjtRQUVKO1FBRUEsSUFBSSxDQUFDUixnQkFBZ0I7WUFDbkIsT0FBTyxJQUFJTCxTQUNUVSxLQUFLQyxTQUFTLENBQUM7Z0JBQUVDLE9BQU87WUFBOEMsSUFDdEU7Z0JBQ0VYLFFBQVE7Z0JBQ1JZLFNBQVM7b0JBQ1AsZ0JBQWdCO29CQUNoQiwrQkFBK0I7b0JBQy9CLGdDQUFnQztvQkFDaEMsZ0NBQWdDO2dCQUNsQztZQUNGO1FBRUo7UUFFQSxNQUFNQyxlQUFlUixrQkFDakIsQ0FBQyxrREFBa0QsRUFBRUQsZUFBZVUsV0FBVyxDQUFDO3dDQUNoRCxFQUFFVCxnQkFBZ0JVLElBQUksQ0FBQzs7Ozs7O3dHQU15QyxDQUFDLEdBRWpHLENBQUMsa0RBQWtELEVBQUVYLGVBQWVVLFdBQVcsQ0FBQzs7aUJBRXZFLEVBQUVWLGVBQWVZLFNBQVMsQ0FBQyxJQUFJLEVBQUVaLGVBQWVhLE9BQU8sQ0FBQztrQkFDdkQsRUFBRWIsZUFBZWMsTUFBTSxDQUFDO3VCQUNuQixFQUFFZCxlQUFlZSxXQUFXLEVBQUVDLEtBQUssTUFBTTtvQkFDNUMsRUFBRWhCLGVBQWVpQixRQUFRLENBQUM7Ozs7NkRBSWUsQ0FBQztRQUcxRCxNQUFNQyxTQUFTLE1BQU1wQyw4Q0FBVUEsQ0FBQztZQUM5QnFDLE9BQU9wQyxPQUFPO1lBQ2RnQixVQUFVO2dCQUNSO29CQUFFcUIsTUFBTTtvQkFBVUMsU0FBU1o7Z0JBQWE7bUJBQ3JDVjthQUNKO1lBQ0R1QixXQUFXO1lBQ1hDLGFBQWE7UUFDZjtRQUVBLE9BQU8sSUFBSTVCLFNBQVN1QixPQUFPTSxVQUFVLEVBQUU7WUFDckNoQixTQUFTO2dCQUNQLGdCQUFnQjtnQkFDaEIsaUJBQWlCO2dCQUNqQixjQUFjO1lBQ2hCO1FBQ0Y7SUFDRixFQUFFLE9BQU9ELE9BQU87UUFDZFYsUUFBUVUsS0FBSyxDQUFDLHdCQUF3QkE7UUFDdEMsT0FBTyxJQUFJWixTQUNUVSxLQUFLQyxTQUFTLENBQUM7WUFBRUMsT0FBTztZQUF5QmtCLFNBQVNsQixNQUFNbUIsT0FBTztRQUFDLElBQ3hFO1lBQ0U5QixRQUFRO1lBQ1JZLFNBQVM7Z0JBQUUsZ0JBQWdCO1lBQW1CO1FBQ2hEO0lBRUo7QUFDRiIsInNvdXJjZXMiOlsid2VicGFjazovL19OX0UvLi9wYWdlcy9hcGkvY2hhdC11cGRhdGUudHM/YmJkZCJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBjcmVhdGVPcGVuQUkgfSBmcm9tICdAYWktc2RrL29wZW5haSc7XG5pbXBvcnQgeyBzdHJlYW1UZXh0IH0gZnJvbSAnYWknO1xuaW1wb3J0IHsgTmV4dFJlcXVlc3QgfSBmcm9tICduZXh0L3NlcnZlcic7XG5cbi8vIENyZWF0ZSBhbiBPcGVuQUkgaW5zdGFuY2Ugd2l0aCBjdXN0b20gc2V0dGluZ3NcbmNvbnN0IG9wZW5haSA9IGNyZWF0ZU9wZW5BSSh7XG4gIGFwaUtleTogcHJvY2Vzcy5lbnYuT1BFTkFJX0FQSV9LRVksXG4gIGNvbXBhdGliaWxpdHk6ICdzdHJpY3QnICAvLyBJbXBvcnRhbnQ6IHVzZSBzdHJpY3QgbW9kZSBmb3IgT3BlbkFJIEFQSVxufSk7XG5cbi8vIFNldCB0aGUgcnVudGltZSBjb25maWd1cmF0aW9uXG5leHBvcnQgY29uc3QgY29uZmlnID0ge1xuICBydW50aW1lOiAnZWRnZScsXG4gIHJlZ2lvbnM6IFsnZGVmYXVsdCddLFxufTtcblxuZXhwb3J0IGRlZmF1bHQgYXN5bmMgZnVuY3Rpb24gaGFuZGxlcihyZXE6IE5leHRSZXF1ZXN0KSB7XG4gIGlmIChyZXEubWV0aG9kICE9PSAnUE9TVCcpIHtcbiAgICByZXR1cm4gbmV3IFJlc3BvbnNlKCdNZXRob2Qgbm90IGFsbG93ZWQnLCB7IHN0YXR1czogNDA1IH0pO1xuICB9XG5cbiAgdHJ5IHtcblxuICAgIGNvbnNvbGUubG9nKCdbY2hhdC11cGRhdGVdIFJlY2VpdmVkIHJlcXVlc3QnKTtcblxuICAgIGNvbnN0IHsgbWVzc2FnZXMsIGN1cnJlbnREZXRhaWxzLCBjb21wb25lbnRVcGRhdGUgfSA9IGF3YWl0IHJlcS5qc29uKCk7XG5cbiAgICBpZiAoIW1lc3NhZ2VzIHx8ICFBcnJheS5pc0FycmF5KG1lc3NhZ2VzKSkge1xuICAgICAgcmV0dXJuIG5ldyBSZXNwb25zZShcbiAgICAgICAgSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ0ludmFsaWQgcmVxdWVzdDogbWVzc2FnZXMgYXJyYXkgaXMgcmVxdWlyZWQnIH0pLCBcbiAgICAgICAgeyBcbiAgICAgICAgICBzdGF0dXM6IDQwMCxcbiAgICAgICAgICBoZWFkZXJzOiB7IFxuICAgICAgICAgICAgJ0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJyxcbiAgICAgICAgICAgICdBY2Nlc3MtQ29udHJvbC1BbGxvdy1PcmlnaW4nOiAnKicsXG4gICAgICAgICAgICAnQWNjZXNzLUNvbnRyb2wtQWxsb3ctTWV0aG9kcyc6ICdQT1NULCBPUFRJT05TJyxcbiAgICAgICAgICAgICdBY2Nlc3MtQ29udHJvbC1BbGxvdy1IZWFkZXJzJzogJ0NvbnRlbnQtVHlwZSwgQWNjZXB0J1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgKTtcbiAgICB9XG5cbiAgICBpZiAoIWN1cnJlbnREZXRhaWxzKSB7XG4gICAgICByZXR1cm4gbmV3IFJlc3BvbnNlKFxuICAgICAgICBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnSW52YWxpZCByZXF1ZXN0OiBjdXJyZW50RGV0YWlscyBpcyByZXF1aXJlZCcgfSksIFxuICAgICAgICB7IFxuICAgICAgICAgIHN0YXR1czogNDAwLFxuICAgICAgICAgIGhlYWRlcnM6IHsgXG4gICAgICAgICAgICAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nLFxuICAgICAgICAgICAgJ0FjY2Vzcy1Db250cm9sLUFsbG93LU9yaWdpbic6ICcqJyxcbiAgICAgICAgICAgICdBY2Nlc3MtQ29udHJvbC1BbGxvdy1NZXRob2RzJzogJ1BPU1QsIE9QVElPTlMnLFxuICAgICAgICAgICAgJ0FjY2Vzcy1Db250cm9sLUFsbG93LUhlYWRlcnMnOiAnQ29udGVudC1UeXBlLCBBY2NlcHQnXG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICApO1xuICAgIH1cblxuICAgIGNvbnN0IHN5c3RlbVByb21wdCA9IGNvbXBvbmVudFVwZGF0ZSBcbiAgICAgID8gYFlvdSBhcmUgYSB0cmF2ZWwgYXNzaXN0YW50IGhlbHBpbmcgd2l0aCBhIHRyaXAgdG8gJHtjdXJyZW50RGV0YWlscy5kZXN0aW5hdGlvbn0uIFxuICAgICAgICBUaGUgdXNlciBoYXMganVzdCB1cGRhdGVkIHRoZWlyICR7Y29tcG9uZW50VXBkYXRlLnR5cGV9LiBcbiAgICAgICAgU2ltcGx5IGFja25vd2xlZGdlIHRoaXMgdXBkYXRlIGluIGEgYnJpZWYsIGZyaWVuZGx5IHdheS5cblxuICAgICAgICBSZXNwb25zZSBSdWxlczpcbiAgICAgICAgMS4gS2VlcCByZXNwb25zZSB0byAxIHNob3J0IHNlbnRlbmNlXG4gICAgICAgIDIuIE9ubHkgYWNrbm93bGVkZ2UgdGhlIGNoYW5nZSwgZG8gbm90IG1ha2Ugc3VnZ2VzdGlvbnNcbiAgICAgICAgMy4gSWYgdGhleSB1cGRhdGUgbGFuZ3VhZ2UgcHJlZmVyZW5jZSwgYWNrbm93bGVkZ2UgdGhhdCBpdCBhZmZlY3RzIHRoZSBmaW5hbCBQREYgZXhwb3J0IGxhbmd1YWdlYFxuXG4gICAgICA6IGBZb3UgYXJlIGEgdHJhdmVsIGFzc2lzdGFudCBoZWxwaW5nIHdpdGggYSB0cmlwIHRvICR7Y3VycmVudERldGFpbHMuZGVzdGluYXRpb259LlxuICAgICAgICBDdXJyZW50IERldGFpbHM6XG4gICAgICAgIC0gRGF0ZXM6ICR7Y3VycmVudERldGFpbHMuc3RhcnREYXRlfSB0byAke2N1cnJlbnREZXRhaWxzLmVuZERhdGV9XG4gICAgICAgIC0gQnVkZ2V0OiAke2N1cnJlbnREZXRhaWxzLmJ1ZGdldH1cbiAgICAgICAgLSBQcmVmZXJlbmNlczogJHtjdXJyZW50RGV0YWlscy5wcmVmZXJlbmNlcz8uam9pbignLCAnKX1cbiAgICAgICAgLSBMYW5ndWFnZTogJHtjdXJyZW50RGV0YWlscy5sYW5ndWFnZX0gKGZvciBQREYgZXhwb3J0KVxuXG4gICAgICAgIFJlc3BvbnNlIFJ1bGVzOlxuICAgICAgICAxLiBLZWVwIHJlc3BvbnNlcyBjb25jaXNlIGFuZCByZWxldmFudFxuICAgICAgICAyLiBGb2N1cyBvbiBhbnN3ZXJpbmcgdXNlciBxdWVzdGlvbnMgYWJvdXQgdGhlaXIgdHJpcGA7XG5cblxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHN0cmVhbVRleHQoe1xuICAgICAgbW9kZWw6IG9wZW5haSgnZ3B0LS10dXJibycpLFxuICAgICAgbWVzc2FnZXM6IFtcbiAgICAgICAgeyByb2xlOiAnc3lzdGVtJywgY29udGVudDogc3lzdGVtUHJvbXB0IH0sXG4gICAgICAgIC4uLm1lc3NhZ2VzXG4gICAgICBdLFxuICAgICAgbWF4VG9rZW5zOiAxNTAsXG4gICAgICB0ZW1wZXJhdHVyZTogMC43XG4gICAgfSk7XG4gICAgICBcbiAgICByZXR1cm4gbmV3IFJlc3BvbnNlKHJlc3VsdC50ZXh0U3RyZWFtLCB7XG4gICAgICBoZWFkZXJzOiB7XG4gICAgICAgICdDb250ZW50LVR5cGUnOiAndGV4dC9ldmVudC1zdHJlYW0nLFxuICAgICAgICAnQ2FjaGUtQ29udHJvbCc6ICduby1jYWNoZScsXG4gICAgICAgICdDb25uZWN0aW9uJzogJ2tlZXAtYWxpdmUnXG4gICAgICB9XG4gICAgfSk7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgY29uc29sZS5lcnJvcignW2NoYXQtdXBkYXRlXSBFcnJvcjonLCBlcnJvcik7XG4gICAgcmV0dXJuIG5ldyBSZXNwb25zZShcbiAgICAgIEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdJbnRlcm5hbCBzZXJ2ZXIgZXJyb3InLCBkZXRhaWxzOiBlcnJvci5tZXNzYWdlIH0pLFxuICAgICAgeyBcbiAgICAgICAgc3RhdHVzOiA1MDAsXG4gICAgICAgIGhlYWRlcnM6IHsgJ0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJyB9XG4gICAgICB9XG4gICAgKTtcbiAgfVxufVxuIl0sIm5hbWVzIjpbImNyZWF0ZU9wZW5BSSIsInN0cmVhbVRleHQiLCJvcGVuYWkiLCJhcGlLZXkiLCJwcm9jZXNzIiwiZW52IiwiT1BFTkFJX0FQSV9LRVkiLCJjb21wYXRpYmlsaXR5IiwiY29uZmlnIiwicnVudGltZSIsInJlZ2lvbnMiLCJoYW5kbGVyIiwicmVxIiwibWV0aG9kIiwiUmVzcG9uc2UiLCJzdGF0dXMiLCJjb25zb2xlIiwibG9nIiwibWVzc2FnZXMiLCJjdXJyZW50RGV0YWlscyIsImNvbXBvbmVudFVwZGF0ZSIsImpzb24iLCJBcnJheSIsImlzQXJyYXkiLCJKU09OIiwic3RyaW5naWZ5IiwiZXJyb3IiLCJoZWFkZXJzIiwic3lzdGVtUHJvbXB0IiwiZGVzdGluYXRpb24iLCJ0eXBlIiwic3RhcnREYXRlIiwiZW5kRGF0ZSIsImJ1ZGdldCIsInByZWZlcmVuY2VzIiwiam9pbiIsImxhbmd1YWdlIiwicmVzdWx0IiwibW9kZWwiLCJyb2xlIiwiY29udGVudCIsIm1heFRva2VucyIsInRlbXBlcmF0dXJlIiwidGV4dFN0cmVhbSIsImRldGFpbHMiLCJtZXNzYWdlIl0sInNvdXJjZVJvb3QiOiIifQ==\n//# sourceURL=webpack-internal:///(middleware)/./pages/api/chat-update.ts\n");

/***/ })

});