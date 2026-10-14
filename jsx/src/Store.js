export const initialState = {
  user_data: undefined,
  user_page: undefined,
  groups_data: undefined,
  groups_page: undefined,
  limit: window.api_page_limit || 100,
};

export const reducers = (state = initialState, action) => {
  switch (action.type) {
    // Updates the client user model data and stores the page
    case "USER_PAGE": {
      const value = action.value || {};
      // Ignore malformed payloads, e.g. failed or garbled reads, so that
      // an unsuccessful fetch can never replace a still-valid user list.
      // An empty data array is valid and must still be stored.
      if (!Array.isArray(value.data) || value.page == null) {
        return state;
      }
      return Object.assign({}, state, {
        user_page: value.page,
        user_data: value.data,
      });
    }

    case "GROUPS_PAGE":
      return Object.assign({}, state, {
        groups_page: action.value.page,
        groups_data: action.value.data,
      });

    default:
      return state;
  }
};
